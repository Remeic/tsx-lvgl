idf_component_register(
    SRCS "app_main.c" "display_startup.c" "runtime_probe.c" "lvgl_host.c" "bundle_transport.c"
    INCLUDE_DIRS "."
    EMBED_TXTFILES "kernel.js" "app.g1.js" "app.g1.manifest.json"
    REQUIRES esp32_s3_touch_amoled_1_8 esp_lcd_touch_ft5x06 waveshare_v1_sensors waveshare_v1_wifi quickjs-ng esp_timer heap esp_driver_i2c esp_driver_usb_serial_jtag mbedtls
)
