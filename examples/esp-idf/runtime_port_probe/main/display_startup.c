#include "display_startup.h"

#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "bsp/touch.h"
#include "driver/i2c_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch_ft5x06.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <stdbool.h>
#include <stdint.h>

static const char *TAG = "tsx_display_startup";

/* A warm reset can leave the FT3168 holding the shared BSP bus. Recovery is
 * deliberately bounded and reuses the BSP-created bus; this module never
 * creates a second I2C owner or a polling retry loop. */
#define WAVESHARE_V1_TOUCH_BUS_SETTLE_MS (20U)
#define WAVESHARE_V1_TOUCH_INIT_ATTEMPTS (2U)

static bool s_display_started;

static esp_err_t prepare_touch_bus(void)
{
    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    if (bus == NULL) {
        ESP_LOGW(TAG, "touch_bus_reset status=unavailable");
        return ESP_ERR_INVALID_STATE;
    }

    const esp_err_t result = i2c_master_bus_reset(bus);
    ESP_LOGI(TAG, "touch_bus_reset status=%s", result == ESP_OK ? "pass" : "fail");
    vTaskDelay(pdMS_TO_TICKS(WAVESHARE_V1_TOUCH_BUS_SETTLE_MS));
    return result;
}

static lv_display_t *start_display_lcd(void)
{
    const lvgl_port_cfg_t lvgl_config = ESP_LVGL_PORT_INIT_CONFIG();
    if (lvgl_port_init(&lvgl_config) != ESP_OK) return NULL;

    bsp_display_config_t display_config = {0};
    esp_lcd_panel_handle_t panel_handle = NULL;
    esp_lcd_panel_io_handle_t panel_io_handle = NULL;
    if (bsp_display_new(&display_config, &panel_handle, &panel_io_handle) != ESP_OK) return NULL;

    int buffer_size = 0;
#if CONFIG_BSP_DISPLAY_LVGL_AVOID_TEAR
    buffer_size = BSP_LCD_H_RES * BSP_LCD_V_RES;
#else
    buffer_size = BSP_LCD_H_RES * LVGL_BUFFER_HEIGHT;
#endif

    const lvgl_port_display_cfg_t display_config_lvgl = {
        .io_handle = panel_io_handle,
        .panel_handle = panel_handle,
        .buffer_size = buffer_size,
        .monochrome = false,
        .hres = BSP_LCD_H_RES,
        .vres = BSP_LCD_V_RES,
#if LVGL_VERSION_MAJOR >= 9
        .color_format = LV_COLOR_FORMAT_RGB565,
#endif
        .rotation = {
            .swap_xy = false,
            .mirror_x = false,
            .mirror_y = false,
        },
        .flags = {
            .sw_rotate = true,
            .buff_dma = false,
#if CONFIG_BSP_DISPLAY_LVGL_PSRAM
            .buff_spiram = false,
#endif
#if CONFIG_BSP_DISPLAY_LVGL_FULL_REFRESH
            .full_refresh = 1,
#elif CONFIG_BSP_DISPLAY_LVGL_DIRECT_MODE
            .direct_mode = 1,
#endif
#if LVGL_VERSION_MAJOR >= 9
            .swap_bytes = true,
#endif
        },
    };
    const lvgl_port_display_rgb_cfg_t rgb_config = {
        .flags = {
#if CONFIG_BSP_LCD_RGB_BOUNCE_BUFFER_MODE
            .bb_mode = 1,
#else
            .bb_mode = 0,
#endif
#if CONFIG_BSP_DISPLAY_LVGL_AVOID_TEAR
            .avoid_tearing = true,
#else
            .avoid_tearing = false,
#endif
        },
    };
    return lvgl_port_add_disp_rgb(&display_config_lvgl, &rgb_config);
}

static esp_err_t start_touch(lv_display_t *display)
{
    if (display == NULL) return ESP_ERR_INVALID_ARG;

    const esp_err_t i2c_result = bsp_i2c_init();
    if (i2c_result != ESP_OK) {
        ESP_LOGW(TAG, "touch_bus_init status=unavailable");
        ESP_LOGW(TAG, "touch_init status=unavailable attempts=0");
        return i2c_result;
    }

    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    if (bus == NULL) {
        ESP_LOGW(TAG, "touch_init status=unavailable attempts=0");
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t last_result = ESP_ERR_INVALID_STATE;
    for (uint32_t attempt = 0; attempt < WAVESHARE_V1_TOUCH_INIT_ATTEMPTS; attempt++) {
        (void)prepare_touch_bus();

        esp_lcd_panel_io_i2c_config_t io_config = ESP_LCD_TOUCH_IO_I2C_FT5x06_CONFIG();
        io_config.scl_speed_hz = CONFIG_BSP_I2C_CLK_SPEED_HZ;
        esp_lcd_panel_io_handle_t touch_io = NULL;
        last_result = esp_lcd_new_panel_io_i2c(bus, &io_config, &touch_io);
        if (last_result == ESP_OK) {
            const esp_lcd_touch_config_t touch_config = {
                .x_max = BSP_LCD_H_RES,
                .y_max = BSP_LCD_V_RES,
                .rst_gpio_num = BSP_LCD_TOUCH_RST,
                .int_gpio_num = BSP_LCD_TOUCH_INT,
                .levels = {
                    .reset = 0,
                    .interrupt = 0,
                },
                .flags = {
                    .swap_xy = 0,
                    .mirror_x = 0,
                    .mirror_y = 0,
                },
            };
            esp_lcd_touch_handle_t touch = NULL;
            last_result = esp_lcd_touch_new_i2c_ft5x06(touch_io, &touch_config, &touch);
            if (last_result == ESP_OK && touch != NULL) {
                const lvgl_port_touch_cfg_t touch_config_lvgl = {
                    .disp = display,
                    .handle = touch,
                };
                if (lvgl_port_add_touch(&touch_config_lvgl) != NULL) {
                    ESP_LOGI(TAG, "touch_init status=pass attempt=%u", (unsigned)(attempt + 1U));
                    return ESP_OK;
                }
                last_result = ESP_ERR_NO_MEM;
                (void)esp_lcd_touch_del(touch);
            }
            /* The managed FT5x06 constructor does not own panel IO on every
             * failed path; close it before the bounded retry. */
            (void)esp_lcd_panel_io_del(touch_io);
        }

        ESP_LOGW(TAG, "touch_init status=retry attempt=%u err=%s",
                 (unsigned)(attempt + 1U), esp_err_to_name(last_result));
    }

    ESP_LOGW(TAG, "touch_init status=unavailable attempts=%u err=%s",
             (unsigned)WAVESHARE_V1_TOUCH_INIT_ATTEMPTS, esp_err_to_name(last_result));
    return last_result;
}

esp_err_t waveshare_v1_display_start(void)
{
    if (s_display_started) return ESP_OK;

    (void)prepare_touch_bus();
    lv_display_t *display = start_display_lcd();
    if (display == NULL) {
        ESP_LOGE(TAG, "display_init status=fail");
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "display_init status=pass panel=sh8601");

    const esp_err_t touch_result = start_touch(display);
    if (touch_result != ESP_OK) {
        ESP_LOGW(TAG, "touch capability status=unavailable");
    }

    const esp_err_t brightness_result = bsp_display_brightness_init();
    if (brightness_result != ESP_OK) {
        ESP_LOGW(TAG, "brightness_init status=unavailable");
    } else {
        const esp_err_t set_result = bsp_display_brightness_set(85);
        ESP_LOGI(TAG, "brightness_set status=%s", set_result == ESP_OK ? "pass" : "unavailable");
    }

    s_display_started = true;
    return ESP_OK;
}
