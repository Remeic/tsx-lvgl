#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void tsx_lvgl_ui_create(void);

static const char *TAG = "tsx_lvgl_v1";

void app_main(void)
{
    ESP_LOGI(TAG, "Starting TSX-LVGL V1 tracer bullet");
    ESP_LOGI(TAG, "Expected board adapter: SH8601 display + FT3168 touch");

    lv_display_t *display = bsp_display_start();
    if (display == NULL) {
        ESP_LOGE(TAG, "V1 display/touch BSP startup failed");
        return;
    }

    ESP_ERROR_CHECK(bsp_display_brightness_set(85));

    if (!bsp_display_lock(0)) {
        ESP_LOGE(TAG, "Could not acquire LVGL lock");
        return;
    }

    tsx_lvgl_ui_create();
    bsp_display_unlock();

    ESP_LOGI(TAG, "TSX-LVGL UI installed; touch action is labelled touch_probe");
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
