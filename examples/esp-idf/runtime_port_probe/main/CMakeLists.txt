idf_component_register(
    SRCS "app_main.c" "runtime_probe.c" "lvgl_host.c" "bundle_transport.c"
    INCLUDE_DIRS "."
    EMBED_TXTFILES "kernel.js" "shakeface.g1.js" "shakeface.g1.manifest.json"
    REQUIRES esp32_s3_touch_amoled_1_8 waveshare_v1_sensors quickjs-ng esp_timer heap esp_driver_i2c esp_driver_usb_serial_jtag mbedtls
)
