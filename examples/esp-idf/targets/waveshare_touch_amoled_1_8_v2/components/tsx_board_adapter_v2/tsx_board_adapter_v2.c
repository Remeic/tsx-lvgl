#include "tsx_board_adapter_v2.h"

#include "bsp/esp-bsp.h"
#include "driver/i2c_master.h"
#include "esp_io_expander.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_touch.h"
#include "esp_lcd_touch_cst816s.h"
#include "esp_lvgl_port.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "tsx_board_identity_v2.h"
#include "tsx_board_target_id.h"

#include <stddef.h>

static const char *TAG = "tsx_board_v2";

#define WAVESHARE_V2_FT5X06_ADDRESS (0x38U)
#define WAVESHARE_V2_CST816S_ADDRESS (0x15U)
#define WAVESHARE_V2_IDENTITY_PROBE_TIMEOUT_MS (100)
#define WAVESHARE_V2_I2C_SETTLE_MS (20U)
#define WAVESHARE_V2_CST816S_X_GAP (0x10U)

static bool s_display_started;
static bool s_display_failed;

typedef struct {
    esp_io_expander_handle_t expander;
    bool lvgl_port_initialized;
    esp_lcd_panel_io_handle_t panel_io;
    esp_lcd_panel_handle_t panel;
    lv_display_t *display;
    esp_lcd_panel_io_handle_t touch_io;
    esp_lcd_touch_handle_t touch;
    lv_indev_t *touch_indev;
} v2_display_resources_t;

static const char *v2_target_id(void *context)
{
    (void)context;
    return TSX_BOARD_TARGET_ID;
}

static tsx_board_probe_result_t probe_address(i2c_master_bus_handle_t bus, uint16_t address)
{
    const esp_err_t result = i2c_master_probe(bus, address, WAVESHARE_V2_IDENTITY_PROBE_TIMEOUT_MS);
    if (result == ESP_OK) return TSX_BOARD_PROBE_ACK;
    if (result == ESP_ERR_NOT_FOUND) return TSX_BOARD_PROBE_NO_ACK;
    return TSX_BOARD_PROBE_ERROR;
}

static esp_err_t v2_probe_identity(void *context, tsx_board_identity_t *out_identity)
{
    (void)context;
    if (out_identity == NULL) return ESP_ERR_INVALID_ARG;
    *out_identity = (tsx_board_identity_t) {
        .state = TSX_BOARD_IDENTITY_UNKNOWN,
        .evidence_code = TSX_BOARD_EVIDENCE_PROBE_ERROR,
    };

    /* The managed BSP owns this shared bus. This read-only probe runs before
     * display startup and never writes a controller register. */
    if (bsp_i2c_init() != ESP_OK) return ESP_OK;
    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    if (bus == NULL) return ESP_OK;
    const esp_err_t reset_result = i2c_master_bus_reset(bus);
    vTaskDelay(pdMS_TO_TICKS(WAVESHARE_V2_I2C_SETTLE_MS));
    if (reset_result != ESP_OK) return ESP_OK;

    const tsx_board_probe_result_t ft5x06 = probe_address(bus, WAVESHARE_V2_FT5X06_ADDRESS);
    const tsx_board_probe_result_t cst816s = probe_address(bus, WAVESHARE_V2_CST816S_ADDRESS);
    *out_identity = tsx_board_classify_v2_identity(ft5x06, cst816s);
    ESP_LOGI(TAG, "board_identity state=%s evidence=%s",
             out_identity->state == TSX_BOARD_IDENTITY_MATCHED ? "pass" :
             out_identity->state == TSX_BOARD_IDENTITY_MISMATCH ? "mismatch" : "unknown",
             out_identity->evidence_code);
    return ESP_OK;
}

static void v2_restore_expander_safe_state(esp_io_expander_handle_t expander)
{
    if (expander == NULL) return;
    /* Keep the panel, touch controller and their rails in reset during every
     * failed bring-up. Each write is attempted so a partial earlier sequence
     * cannot leave one rail asserted by accident. */
    for (uint32_t pin = IO_EXPANDER_PIN_NUM_0; pin <= IO_EXPANDER_PIN_NUM_2; pin <<= 1) {
        const esp_err_t result = esp_io_expander_set_level(expander, pin, 0);
        if (result != ESP_OK) {
            ESP_LOGE(TAG, "io_expander_safe_state pin=%u status=fail err=%s",
                     (unsigned)pin, esp_err_to_name(result));
        }
    }
}

static void v2_cleanup_display(v2_display_resources_t *resources)
{
    if (resources == NULL) return;

    /* Reverse the LVGL ownership graph before deleting the controller handles
     * that the LVGL callbacks reference. Every field is cleared after its
     * delete call, making repeated cleanup safe for this lifecycle boundary. */
    if (resources->touch_indev != NULL) {
        (void)lvgl_port_remove_touch(resources->touch_indev);
        resources->touch_indev = NULL;
    }
    if (resources->touch != NULL) {
        (void)esp_lcd_touch_del(resources->touch);
        resources->touch = NULL;
    }
    if (resources->touch_io != NULL) {
        (void)esp_lcd_panel_io_del(resources->touch_io);
        resources->touch_io = NULL;
    }
    if (resources->display != NULL) {
        (void)lvgl_port_remove_disp(resources->display);
        resources->display = NULL;
    }
    if (resources->lvgl_port_initialized) {
        (void)lvgl_port_deinit();
        resources->lvgl_port_initialized = false;
    }
    if (resources->panel != NULL) {
        (void)esp_lcd_panel_del(resources->panel);
        resources->panel = NULL;
    }
    if (resources->panel_io != NULL) {
        (void)esp_lcd_panel_io_del(resources->panel_io);
        resources->panel_io = NULL;
    }
    v2_restore_expander_safe_state(resources->expander);
    if (resources->expander != NULL) {
        (void)esp_io_expander_del(resources->expander);
        resources->expander = NULL;
    }
}

static esp_err_t v2_display_start(void *context)
{
    (void)context;
    if (s_display_started) return ESP_OK;
    if (s_display_failed) return ESP_ERR_INVALID_STATE;

    v2_display_resources_t resources = {0};
    esp_err_t result = ESP_OK;

    /* The Waveshare V2 composition uses the sequence in its official Arduino
     * V2 example: TCA9554 pins 0, 1 and 2 hold the panel/touch rails in reset,
     * then release them after the required 20 ms settle. This must happen
     * before the BSP's CO5300 constructor touches QSPI. */
    resources.expander = bsp_io_expander_init();
    if (resources.expander == NULL) {
        ESP_LOGE(TAG, "io_expander_init status=fail");
        result = ESP_FAIL;
        goto fail;
    }
    result = esp_io_expander_set_dir(
        resources.expander, IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 | IO_EXPANDER_PIN_NUM_2,
        IO_EXPANDER_OUTPUT);
    if (result != ESP_OK) goto fail;
    if (esp_io_expander_set_level(resources.expander, IO_EXPANDER_PIN_NUM_0, 0) != ESP_OK ||
        esp_io_expander_set_level(resources.expander, IO_EXPANDER_PIN_NUM_1, 0) != ESP_OK ||
        esp_io_expander_set_level(resources.expander, IO_EXPANDER_PIN_NUM_2, 0) != ESP_OK) {
        result = ESP_FAIL;
        goto fail;
    }
    vTaskDelay(pdMS_TO_TICKS(WAVESHARE_V2_I2C_SETTLE_MS));
    if (esp_io_expander_set_level(resources.expander, IO_EXPANDER_PIN_NUM_0, 1) != ESP_OK ||
        esp_io_expander_set_level(resources.expander, IO_EXPANDER_PIN_NUM_1, 1) != ESP_OK ||
        esp_io_expander_set_level(resources.expander, IO_EXPANDER_PIN_NUM_2, 1) != ESP_OK) {
        result = ESP_FAIL;
        goto fail;
    }

    const lvgl_port_cfg_t lvgl_port_config = ESP_LVGL_PORT_INIT_CONFIG();
    result = lvgl_port_init(&lvgl_port_config);
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "lvgl_port_init status=fail");
        goto fail;
    }
    resources.lvgl_port_initialized = true;

    const bsp_display_config_t panel_config = {0};
    result = bsp_display_new(&panel_config, &resources.panel, &resources.panel_io);
    if (result != ESP_OK || resources.panel == NULL || resources.panel_io == NULL) {
        ESP_LOGE(TAG, "co5300_qspi_init status=fail");
        if (result == ESP_OK) result = ESP_FAIL;
        goto fail;
    }
    result = esp_lcd_panel_set_gap(resources.panel, WAVESHARE_V2_CST816S_X_GAP, 0);
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "co5300_x_gap status=fail");
        goto fail;
    }

    const lvgl_port_display_cfg_t display_config = {
        .io_handle = resources.panel_io,
        .panel_handle = resources.panel,
        .buffer_size = BSP_LCD_DRAW_BUFF_SIZE,
        .double_buffer = BSP_LCD_DRAW_BUFF_DOUBLE,
        .hres = BSP_LCD_H_RES,
        .vres = BSP_LCD_V_RES,
        .monochrome = false,
        .rotation = {
            .swap_xy = false,
            .mirror_x = false,
            .mirror_y = false,
        },
        .flags = {
            .sw_rotate = true,
            .buff_spiram = true,
#if LVGL_VERSION_MAJOR >= 9
            .swap_bytes = true,
#endif
        },
#if LVGL_VERSION_MAJOR >= 9
        .color_format = LV_COLOR_FORMAT_RGB565,
#endif
    };
    resources.display = lvgl_port_add_disp(&display_config);
    if (resources.display == NULL) {
        ESP_LOGE(TAG, "display_init status=fail panel=co5300");
        result = ESP_FAIL;
        goto fail;
    }

    /* Keep the CST-compatible API explicit. Identity gating has already
     * established CST ACK + FT no-ACK, so this path cannot silently select
     * the V1 FT driver. */
    esp_lcd_panel_io_i2c_config_t touch_io_config = ESP_LCD_TOUCH_IO_I2C_CST816S_CONFIG();
    touch_io_config.scl_speed_hz = CONFIG_BSP_I2C_CLK_SPEED_HZ;
    result = esp_lcd_new_panel_io_i2c(bsp_i2c_get_handle(), &touch_io_config, &resources.touch_io);
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "touch_io_init status=fail");
        goto fail;
    }
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
    result = esp_lcd_touch_new_i2c_cst816s(resources.touch_io, &touch_config, &resources.touch);
    if (result != ESP_OK || resources.touch == NULL) {
        ESP_LOGE(TAG, "touch_init status=fail");
        if (result == ESP_OK) result = ESP_FAIL;
        goto fail;
    }
    const lvgl_port_touch_cfg_t touch_config_lvgl = {
        .disp = resources.display,
        .handle = resources.touch,
    };
    resources.touch_indev = lvgl_port_add_touch(&touch_config_lvgl);
    if (resources.touch_indev == NULL) {
        ESP_LOGE(TAG, "touch_lvgl_bind status=fail");
        result = ESP_FAIL;
        goto fail;
    }

    ESP_LOGI(TAG, "display_init status=pass panel=co5300 touch=cst820");
    const esp_err_t brightness_result = bsp_display_brightness_set(85);
    ESP_LOGI(TAG, "brightness_set status=%s", brightness_result == ESP_OK ? "pass" : "unavailable");
    s_display_started = true;
    return ESP_OK;

fail:
    s_display_failed = true;
    v2_cleanup_display(&resources);
    return result;
}

static bool v2_display_lock(void *context, uint32_t timeout_ms)
{
    (void)context;
    return bsp_display_lock(timeout_ms);
}

static void v2_display_unlock(void *context)
{
    (void)context;
    bsp_display_unlock();
}

static const tsx_board_boot_port_t V2_BOOT_PORT = {
    .context = NULL,
    .target_id = v2_target_id,
    .display_start = v2_display_start,
    .display_lock = v2_display_lock,
    .display_unlock = v2_display_unlock,
    .probe_identity = v2_probe_identity,
};

const tsx_board_adapter_t *tsx_board_adapter_v2(void)
{
    /* Motion and Wi-Fi are deliberately absent until they have V2-owned
     * provider implementations. The common runtime treats these optional
     * ports as unavailable; it never imports V1 provider types. */
    static const tsx_board_adapter_t adapter = {
        .boot = &V2_BOOT_PORT,
        .motion = NULL,
        .wifi = NULL,
    };
    return &adapter;
}
