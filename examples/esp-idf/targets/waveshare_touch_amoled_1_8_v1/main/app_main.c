#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "runtime_probe.h"
#include "tsx_board_adapter_v1.h"

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

void app_main(void)
{
    const tsx_board_adapter_t *board = tsx_board_adapter_v1();
    const esp_reset_reason_t reset_reason = esp_reset_reason();
    probe_boot_count++;

    ESP_LOGI(TAG, "RUNTIME PROBE BOOT reset_reason=%d boot=%u", (int)reset_reason,
             (unsigned)probe_boot_count);
    ESP_LOGI(TAG, "Target: ESP32-S3 / SH8601 / FT3168 / QMI8658 / LVGL 9.5");

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

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
