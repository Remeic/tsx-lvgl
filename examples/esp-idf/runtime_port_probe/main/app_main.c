#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "bundle_transport.h"
#include "runtime_probe.h"

#include <stdint.h>

static const char *TAG = "tsx_runtime_probe";
static RTC_DATA_ATTR uint32_t probe_boot_count;

#define FT3168_I2C_ADDRESS (0x38U)
#define FT3168_PROBE_ATTEMPTS (10U)
#define FT3168_PROBE_DELAY_MS (50U)

static void wait_for_ft3168(void)
{
    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    if (bus == NULL) {
        ESP_LOGW(TAG, "FT3168 readiness probe skipped: I2C bus unavailable");
        return;
    }

    for (uint32_t attempt = 1; attempt <= FT3168_PROBE_ATTEMPTS; attempt++) {
        const esp_err_t result = i2c_master_probe(bus, FT3168_I2C_ADDRESS, 100);
        if (result == ESP_OK) {
            ESP_LOGI(TAG, "FT3168 readiness pass attempts=%u", (unsigned)attempt);
            return;
        }
        if (attempt < FT3168_PROBE_ATTEMPTS) {
            vTaskDelay(pdMS_TO_TICKS(FT3168_PROBE_DELAY_MS));
        }
    }

    ESP_LOGW(TAG, "FT3168 readiness probe exhausted attempts=%u", FT3168_PROBE_ATTEMPTS);
}

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

    /* I2C discovery/configuration precedes all QuickJS/kernel reads and never
     * runs under the LVGL lock. A failed provider is a failed boot, not a
     * silently degraded app that cannot be retried safely. */
    if (runtime_probe_start_sensors(probe) != ESP_OK) {
        ESP_LOGE(TAG, "PROBE checkpoint=imu_init status=fail");
        runtime_probe_destroy(probe);
        vTaskDelete(NULL);
        return;
    }

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

    if (xTaskCreate(runtime_probe_task, "runtime_probe", 8192, probe, 4, NULL) != pdPASS) {
        ESP_LOGE(TAG, "PROBE checkpoint=runtime_task status=fail");
        runtime_probe_destroy(probe);
        vTaskDelete(NULL);
        return;
    }

    const esp_err_t transport_result = bundle_transport_start(probe);
    ESP_LOGI(TAG, "PROBE checkpoint=bundle_transport_start status=%s",
             transport_result == ESP_OK ? "pass" : "fail");

    vTaskDelete(NULL);
}

void app_main(void)
{
    const esp_reset_reason_t reset_reason = esp_reset_reason();
    probe_boot_count++;

    ESP_LOGI(TAG, "RUNTIME PROBE BOOT reset_reason=%d boot=%u", (int)reset_reason,
             (unsigned)probe_boot_count);
    ESP_LOGI(TAG, "Target: ESP32-S3 / SH8601 / FT3168 / QMI8658 / LVGL 9.5");

    wait_for_ft3168();
    lv_display_t *display = bsp_display_start();
    if (display == NULL) {
        ESP_LOGE(TAG, "PROBE checkpoint=board_start status=fail");
        return;
    }

    ESP_ERROR_CHECK(bsp_display_brightness_set(85));
    ESP_LOGI(TAG, "PROBE checkpoint=board_start status=pass");

    if (xTaskCreate(runtime_probe_boot_task, "runtime_probe_boot", 12288, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "PROBE checkpoint=boot_task status=fail");
        return;
    }

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
