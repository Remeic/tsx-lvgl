idf_component_register(
    SRCS "runtime_probe.c" "lvgl_host.c" "bundle_transport.c"
    INCLUDE_DIRS "include"
    REQUIRES tsx_board_adapter quickjs-ng lvgl esp_timer heap esp_driver_usb_serial_jtag mbedtls
)
