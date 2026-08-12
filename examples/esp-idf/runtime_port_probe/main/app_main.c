#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "bundle_transport.h"
#include "display_startup.h"
#include "runtime_probe.h"

#include <stdint.h>

static const char *TAG = "tsx_runtime_probe";
static RTC_DATA_ATTR uint32_t probe_boot_count;

/* QuickJS mount and the owner pump share one bounded task. The board cannot
 * reliably reserve a second native owner stack after the runtime and
 * providers are live; keeping one owner also preserves the single LVGL lock
 * boundary. */
/* Nested LVGL reparenting plus the style ABI can recurse through layout while
 * the owner task mounts a candidate tree. Keep enough headroom for that
 * native call chain; the project permits task stacks in external PSRAM. */
#define RUNTIME_PROBE_BOOT_STACK_WORDS (16384U)

static void runtime_probe_boot_task(void *arg)
{
    (void)arg;

    runtime_probe_t *probe = NULL;
    const esp_err_t result = runtime_probe_start(&probe);
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "PROBE checkpoint=runtime_start status=fail err=%s",
                 esp_err_to_name(result));
        vTaskDelete(NULL);
        return;
    }

    /* Reserve the bounded transport worker while the runtime still owns the
     * most available task memory. Optional providers are started afterwards;
     * they must not be able to starve the device-backed development path. */
    const esp_err_t transport_result = bundle_transport_start(probe);
    ESP_LOGI(TAG, "PROBE checkpoint=bundle_transport_start status=%s",
             transport_result == ESP_OK ? "pass" : "fail");

    /* Providers are optional. They report unavailable state to the existing
     * runtime while the display and app remain alive. */
    const esp_err_t sensors_result = runtime_probe_start_sensors(probe);
    if (sensors_result != ESP_OK) ESP_LOGW(TAG, "PROBE checkpoint=imu_init status=unavailable");

    /* Wi-Fi owns a separate bounded native worker, but remains optional for
     * this local display slice and never tears down the mounted UI. */
    const esp_err_t connectivity_result = runtime_probe_start_connectivity(probe);
    if (connectivity_result != ESP_OK) ESP_LOGW(TAG, "PROBE checkpoint=wifi_init status=unavailable");

    if (!bsp_display_lock(0)) {
        ESP_LOGE(TAG, "PROBE checkpoint=lvgl_lock status=fail");
        runtime_probe_destroy(probe);
        vTaskDelete(NULL);
        return;
    }
    const esp_err_t boot_result = runtime_probe_boot(probe);
    bsp_display_unlock();
    if (boot_result != ESP_OK) {
        ESP_LOGE(TAG, "PROBE checkpoint=kernel_boot status=fail err=%s", esp_err_to_name(boot_result));
        runtime_probe_destroy(probe);
        vTaskDelete(NULL);
        return;
    }

    /* Keep one owner for all QuickJS/LVGL calls. runtime_probe_task deletes
     * the current task when the probe is stopped, so no second stack is
     * allocated after QuickJS and the providers are live. */
    runtime_probe_task(probe);
}

void app_main(void)
{
    const esp_reset_reason_t reset_reason = esp_reset_reason();
    probe_boot_count++;

    ESP_LOGI(TAG, "RUNTIME PROBE BOOT reset_reason=%d boot=%u", (int)reset_reason,
             (unsigned)probe_boot_count);
    ESP_LOGI(TAG, "Target: ESP32-S3 / SH8601 / FT3168 / QMI8658 / LVGL 9.5");

    if (waveshare_v1_display_start() != ESP_OK) {
        ESP_LOGE(TAG, "PROBE checkpoint=board_start status=fail");
        return;
    }

    ESP_LOGI(TAG, "PROBE checkpoint=board_start status=pass");

    if (xTaskCreate(runtime_probe_boot_task, "runtime_probe_boot", RUNTIME_PROBE_BOOT_STACK_WORDS, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "PROBE checkpoint=boot_task status=fail");
        return;
    }

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
