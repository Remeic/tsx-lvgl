#include "tsx_board_adapter_v2.h"

#include "bsp/esp-bsp.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "tsx_board_identity_v2.h"
#include "tsx_board_target_id.h"

#include <stddef.h>

static const char *TAG = "tsx_board_v2";

#define WAVESHARE_V2_FT5X06_ADDRESS (0x38U)
#define WAVESHARE_V2_CST816S_ADDRESS (0x15U)
#define WAVESHARE_V2_IDENTITY_PROBE_TIMEOUT_MS (100)
#define WAVESHARE_V2_I2C_SETTLE_MS (20U)

static bool s_display_started;

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

static esp_err_t v2_display_start(void *context)
{
    (void)context;
    if (s_display_started) return ESP_OK;

    /* BSP 2.0.3 owns the TCAL9534/TCA9554 power-reset sequence, CO5300 QSPI
     * panel IO and CST816S-compatible touch registration. The fitted touch
     * part remains documented as CST820; the API family name is not evidence
     * of a different physical controller. */
    lv_display_t *display = bsp_display_start();
    if (display == NULL) {
        ESP_LOGE(TAG, "display_init status=fail panel=co5300");
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "display_init status=pass panel=co5300 touch=cst820");
    const esp_err_t brightness_result = bsp_display_brightness_set(85);
    ESP_LOGI(TAG, "brightness_set status=%s", brightness_result == ESP_OK ? "pass" : "unavailable");
    s_display_started = true;
    return ESP_OK;
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
