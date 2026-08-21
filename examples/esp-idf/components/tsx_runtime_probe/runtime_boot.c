#include "runtime_probe.h"

#include "bundle_transport.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <stdbool.h>
#include <stdint.h>

static const char *TAG = "tsx_runtime_probe";
static RTC_DATA_ATTR uint32_t probe_boot_count;
/* Bounds reject-mode resets; cleared on power-on or a matched boot. */
static RTC_DATA_ATTR uint32_t s_reject_reset_count;

/* QuickJS, LVGL and provider ownership stay on one bounded task. */
#define RUNTIME_PROBE_BOOT_STACK_WORDS (32768U)
#define REJECT_TRANSPORT_START_ATTEMPTS (3U)
#define REJECT_TRANSPORT_RETRY_BACKOFF_MS (100U)
/* Bounded reject-mode resets: after this many consecutive diagnostic-transport
 * failures the board halts in diagnostic mode instead of looping forever. */
#define REJECT_RESET_LIMIT (3U)

static void runtime_probe_owner_task(void *arg)
{
    const runtime_probe_context_t *boot = arg;
    esp_err_t result;
    do {
        result = runtime_probe_run(boot->board, boot->assets);
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

static _Noreturn void remain_in_rejected_diagnostic_mode(void)
{
    while (true) vTaskDelay(pdMS_TO_TICKS(1000));
}

/* Never returns: every path either parks forever or restarts the chip. The
 * _Noreturn contract makes a future fall-through into display/runtime boot on
 * unverified hardware a compile error, not a silent safety hole. */
static _Noreturn void enter_rejected_diagnostic_mode(const char *reason)
{
    if (!run_rejected_diagnostic_transport(reason)) {
        /* The bounded retry did not establish the recovery channel. A
         * controlled reset gives the board a deterministic next attempt;
         * the RTC counter bounds the loop. At the limit the board parks in
         * diagnostic mode forever; it must never fall through to display or
         * runtime boot on unverified hardware. */
        s_reject_reset_count += 1U;
        if (s_reject_reset_count >= REJECT_RESET_LIMIT) {
            ESP_LOGE(TAG, "PROBE checkpoint=bundle_transport_start status=terminal mode=reject reason=%s action=halt resets=%u",
                     reason, (unsigned)s_reject_reset_count);
            remain_in_rejected_diagnostic_mode();
        }
        esp_restart();
    }
    remain_in_rejected_diagnostic_mode();
}

void runtime_probe_app_main(const tsx_board_adapter_t *board,
                            const runtime_probe_assets_t *assets,
                            const char *target_description)
{
    const esp_reset_reason_t reset_reason = esp_reset_reason();
    probe_boot_count++;

    ESP_LOGI(TAG, "RUNTIME PROBE BOOT reset_reason=%d boot=%u", (int)reset_reason,
             (unsigned)probe_boot_count);
    ESP_LOGI(TAG, "Target: %s", target_description != NULL ? target_description : "unknown");

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
        enter_rejected_diagnostic_mode(reason);
    }

    if (tsx_board_adapter_display_start(board) != ESP_OK) {
        ESP_LOGE(TAG, "PROBE checkpoint=board_start status=fail action=reject reason=hardware-startup-failure");
        enter_rejected_diagnostic_mode("hardware-startup-failure");
        return;
    }
    ESP_LOGI(TAG, "PROBE checkpoint=board_start status=pass");
    s_reject_reset_count = 0;

    static runtime_probe_context_t boot_context;
    boot_context.board = board;
    boot_context.assets = assets;
    if (xTaskCreate(runtime_probe_owner_task, "runtime_probe_owner", RUNTIME_PROBE_BOOT_STACK_WORDS,
                    &boot_context, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "PROBE checkpoint=boot_task status=fail");
        return;
    }
    while (true) vTaskDelay(pdMS_TO_TICKS(1000));
}
