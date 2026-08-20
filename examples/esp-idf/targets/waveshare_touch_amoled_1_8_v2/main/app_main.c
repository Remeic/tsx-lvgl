#include "runtime_probe.h"
#include "tsx_board_adapter_v2.h"

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

void app_main(void)
{
    runtime_probe_app_main(tsx_board_adapter_v2(), &RUNTIME_ASSETS,
                           "ESP32-S3 / CO5300 / CST820 / motion=unavailable / LVGL 9.5");
}
