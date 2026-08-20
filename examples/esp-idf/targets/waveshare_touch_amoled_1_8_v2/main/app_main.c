#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "bundle_transport.h"
#include "runtime_probe.h"
#include "tsx_board_adapter_v2.h"

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

static const char *TAG = "tsx_runtime_probe_v2";
static RTC_DATA_ATTR uint32_t probe_boot_count;

#define RUNTIME_PROBE_BOOT_STACK_WORDS (32768U)
#define REJECT_TRANSPORT_START_ATTEMPTS (3U)
#define REJECT_TRANSPORT_RETRY_BACKOFF_MS (100U)

static void runtime_probe_owner_task(void *arg)
{
    const tsx_board_adapter_t *board = arg;
    esp_err_t result;
    do {
        result = runtime_probe_run(board, &RUNTIME_ASSETS);
        if (result == ESP_ERR_TIMEOUT) vTaskDelay(pdMS_TO_TICKS(20));
    } while (result == ESP_ERR_TIMEOUT);
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "PROBE checkpoint=runtime_owner status=fail err=%s", esp_err_to_name(result));
    }
    vTaskDelete(NULL);
}

static const char *identity_status(tsx_board_identity_state_t state)
{
    switch (state) {
        case TSX_BOARD_IDENTITY_MATCHED: return "pass";
        case TSX_BOARD_IDENTITY_MISMATCH: return "mismatch";
        case TSX_BOARD_IDENTITY_UNKNOWN: return "unknown";
    }
    return "unknown";
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
    ESP_LOGE(TAG, "PROBE checkpoint=bundle_transport_start status=terminal mode=reject reason=%s action=reset", reason);
    return false;
}

static void remain_in_rejected_diagnostic_mode(void)
{
    while (true) vTaskDelay(pdMS_TO_TICKS(1000));
}

void app_main(void)
{
    const tsx_board_adapter_t *board = tsx_board_adapter_v2();
    const esp_reset_reason_t reset_reason = esp_reset_reason();
    probe_boot_count++;

    ESP_LOGI(TAG, "RUNTIME PROBE BOOT reset_reason=%d boot=%u", (int)reset_reason, (unsigned)probe_boot_count);
    ESP_LOGI(TAG, "Target: ESP32-S3 / CO5300 / CST820 / QMI8658 / LVGL 9.5");

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
             identity_status(identity.state), target_id != NULL ? target_id : "unknown",
             identity.evidence_code != NULL ? identity.evidence_code : TSX_BOARD_EVIDENCE_PROBE_ERROR);

    if (!tsx_board_identity_is_matched(identity)) {
        const char *reason = identity.state == TSX_BOARD_IDENTITY_MISMATCH ? "hardware-mismatch" : "hardware-unknown";
        if (!run_rejected_diagnostic_transport(reason)) {
            esp_restart();
            return;
        }
        remain_in_rejected_diagnostic_mode();
    }

    if (tsx_board_adapter_display_start(board) != ESP_OK) {
        ESP_LOGE(TAG, "PROBE checkpoint=board_start status=fail");
        return;
    }
    ESP_LOGI(TAG, "PROBE checkpoint=board_start status=pass");

    if (xTaskCreate(runtime_probe_owner_task, "runtime_probe_owner", RUNTIME_PROBE_BOOT_STACK_WORDS,
                    (void *)board, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "PROBE checkpoint=boot_task status=fail");
        return;
    }
    while (true) vTaskDelay(pdMS_TO_TICKS(1000));
}
