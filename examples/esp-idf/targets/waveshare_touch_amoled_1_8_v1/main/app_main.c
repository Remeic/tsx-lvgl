#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "bundle_transport.h"
#include "runtime_probe.h"
#include "tsx_board_adapter_v1.h"

#include <stdbool.h>
#include <stdint.h>

extern const uint8_t _binary_kernel_js_start[] asm("_binary_kernel_js_start");
extern const uint8_t _binary_kernel_js_end[] asm("_binary_kernel_js_end");
extern const uint8_t _binary_app_g1_js_start[] asm("_binary_app_g1_js_start");
extern const uint8_t _binary_app_g1_manifest_json_start[] asm("_binary_app_g1_manifest_json_start");

static const runtime_probe_assets_t RUNTIME_ASSETS = {
    .kernel_start = _binary_kernel_js_start,
    .kernel_end = _binary_kernel_js_end,
    .app_source = (const char *)_binary_app_g1_js_start,
    .app_manifest = (const char *)_binary_app_g1_manifest_json_start,
};

static const char *TAG = "tsx_runtime_probe";
static RTC_DATA_ATTR uint32_t probe_boot_count;
static RTC_DATA_ATTR uint32_t s_reject_reset_count;

/* QuickJS mount and the owner pump share one bounded task. The board cannot
 * reliably reserve a second native owner stack after the runtime and
 * providers are live; keeping one owner also preserves the single LVGL lock
 * boundary. */
/* Nested LVGL reparenting plus the style ABI can recurse through layout while
 * the owner task mounts a candidate tree. Keep enough headroom for that
 * native call chain; the project permits task stacks in external PSRAM. */
/* 16384 still overflowed while mounting a styled tree of ~8 widgets with two
 * flex containers (hardware panic during kernel boot). */
#define RUNTIME_PROBE_BOOT_STACK_WORDS (32768U)
#define REJECT_TRANSPORT_START_ATTEMPTS (3U)
#define REJECT_TRANSPORT_RETRY_BACKOFF_MS (100U)
/* Bounded reject-mode resets: after this many consecutive diagnostic-transport
 * failures the board halts in diagnostic mode instead of looping forever. */
#define REJECT_RESET_LIMIT (3U)

static void runtime_probe_owner_task(void *arg)
{
    const tsx_board_adapter_t *board = arg;
    esp_err_t result;
    do {
        /* ESP_ERR_TIMEOUT = retained-cleanup retry signal from
         * runtime_probe_run; see the contract in runtime_probe.h. */
        result = runtime_probe_run(board, &RUNTIME_ASSETS);
        if (result == ESP_ERR_TIMEOUT) vTaskDelay(pdMS_TO_TICKS(20));
    } while (result == ESP_ERR_TIMEOUT);
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "PROBE checkpoint=runtime_owner status=fail err=%s",
                 esp_err_to_name(result));
    }
    vTaskDelete(NULL);
}

static bool run_rejected_diagnostic_transport(const char *reason)
{
    for (uint32_t attempt = 1; attempt <= REJECT_TRANSPORT_START_ATTEMPTS; attempt++) {
        const esp_err_t result = bundle_transport_start_rejected(reason);
        ESP_LOGI(TAG, "PROBE checkpoint=bundle_transport_start status=%s mode=reject reason=%s attempt=%u",
                 result == ESP_OK ? "pass" : "fail", reason, (unsigned)attempt);
        if (result == ESP_OK) return true;
        if (attempt < REJECT_TRANSPORT_START_ATTEMPTS) {
            vTaskDelay(pdMS_TO_TICKS(REJECT_TRANSPORT_RETRY_BACKOFF_MS * attempt));
        }
    }

    ESP_LOGE(TAG, "PROBE checkpoint=bundle_transport_start status=terminal mode=reject reason=%s action=reset",
             reason);
    return false;
}

static void remain_in_rejected_diagnostic_mode(void)
{
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void app_main(void)
{
    const tsx_board_adapter_t *board = tsx_board_adapter_v1();
    const esp_reset_reason_t reset_reason = esp_reset_reason();
    probe_boot_count++;

    ESP_LOGI(TAG, "RUNTIME PROBE BOOT reset_reason=%d boot=%u", (int)reset_reason,
             (unsigned)probe_boot_count);
    ESP_LOGI(TAG, "Target: ESP32-S3 / SH8601 / FT3168 / QMI8658 / LVGL 9.5");

    tsx_board_identity_t identity = {
        .state = TSX_BOARD_IDENTITY_UNKNOWN,
        .evidence_code = TSX_BOARD_EVIDENCE_PROBE_ERROR,
    };
    const esp_err_t identity_result = tsx_board_adapter_probe_identity(board, &identity);
    if (identity_result != ESP_OK) {
        identity.state = TSX_BOARD_IDENTITY_UNKNOWN;
        identity.evidence_code = TSX_BOARD_EVIDENCE_PROBE_ERROR;
    }
    const char *target_id = tsx_board_adapter_target_id(board);
    ESP_LOGI(TAG, "PROBE checkpoint=board_identity status=%s target=%s evidence=%s",
             tsx_board_identity_state_name(identity.state), target_id != NULL ? target_id : "unknown",
             identity.evidence_code != NULL ? identity.evidence_code : TSX_BOARD_EVIDENCE_PROBE_ERROR);

    if (!tsx_board_identity_is_matched(identity)) {
        const char *reason = identity.state == TSX_BOARD_IDENTITY_MISMATCH
                                 ? "hardware-mismatch"
                                 : "hardware-unknown";
        if (!run_rejected_diagnostic_transport(reason)) {
            /* The bounded retry did not establish the recovery channel. A
             * controlled reset gives the board a deterministic next attempt;
             * the RTC counter bounds the loop and halts instead of resetting
             * forever on a dead board. The counter clears on power-on or a
             * matched boot. */
            s_reject_reset_count += 1U;
            if (s_reject_reset_count >= REJECT_RESET_LIMIT) {
                ESP_LOGE(TAG, "PROBE checkpoint=bundle_transport_start status=terminal mode=reject reason=%s action=halt resets=%u",
                         reason, (unsigned)s_reject_reset_count);
            } else {
                esp_restart();
            }
            return;
        }
        remain_in_rejected_diagnostic_mode();
    }

    if (tsx_board_adapter_display_start(board) != ESP_OK) {
        ESP_LOGE(TAG, "PROBE checkpoint=board_start status=fail");
        return;
    }
    s_reject_reset_count = 0;

    ESP_LOGI(TAG, "PROBE checkpoint=board_start status=pass");

    if (xTaskCreate(runtime_probe_owner_task, "runtime_probe_owner", RUNTIME_PROBE_BOOT_STACK_WORDS,
                    (void *)board, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "PROBE checkpoint=boot_task status=fail");
        return;
    }

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
