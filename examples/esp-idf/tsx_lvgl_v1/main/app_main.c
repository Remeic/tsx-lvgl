#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdint.h>
#include <stdio.h>

void tsx_lvgl_ui_create(void);

static const char *TAG = "tsx_lvgl_v1";
static RTC_DATA_ATTR uint32_t hot_reload_boot_count;

void app_main(void)
{
    const esp_reset_reason_t reset_reason = esp_reset_reason();
    hot_reload_boot_count++;

    ESP_LOGI(TAG, "TSX-LVGL BOOT reset_reason=%d boot=%u", (int)reset_reason,
             (unsigned)hot_reload_boot_count);
    ESP_LOGI(TAG, "Expected board adapter: SH8601 display + FT3168 touch");

    ESP_LOGI(TAG, "Starting TSX-LVGL V1 tracer bullet");
    lv_display_t *display = bsp_display_start();
    if (display == NULL) {
        ESP_LOGE(TAG, "V1 display/touch BSP startup failed; refusing blind restart");
        return;
    }

    ESP_ERROR_CHECK(bsp_display_brightness_set(85));

    if (!bsp_display_lock(0)) {
        ESP_LOGE(TAG, "Could not acquire LVGL lock");
        return;
    }

    tsx_lvgl_ui_create();

    lv_obj_t *diagnostic_title = lv_label_create(lv_screen_active());
    lv_label_set_text(diagnostic_title, "HOT RELOAD TEST");

    char diagnostic_status[64];
    snprintf(diagnostic_status, sizeof(diagnostic_status), "boot %u / reset %d",
             (unsigned)hot_reload_boot_count, (int)reset_reason);
    lv_obj_t *diagnostic_status_label = lv_label_create(lv_screen_active());
    lv_label_set_text(diagnostic_status_label, diagnostic_status);

    lv_obj_t *diagnostic_hint = lv_label_create(lv_screen_active());
    lv_label_set_text(diagnostic_hint, "reload => boot +1");

    bsp_display_unlock();

    ESP_LOGI(TAG, "TSX-LVGL READY UI installed; touching the button should change its label to Touched");
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
