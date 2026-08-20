set(TSX_BOARD_TARGET_GENERATED_DIR "${CMAKE_CURRENT_LIST_DIR}/../../main/generated")

if(NOT EXISTS "${TSX_BOARD_TARGET_GENERATED_DIR}/tsx_board_target_id.h")
    message(FATAL_ERROR
        "missing generated tsx_board_target_id.h; run npm run board:build -- --target waveshare-touch-amoled-1.8-v2")
endif()

idf_component_register(
    SRCS "tsx_board_adapter_v2.c" "tsx_board_identity_v2.c"
    INCLUDE_DIRS "include"
    REQUIRES tsx_board_adapter esp32_s3_touch_amoled_1_8 esp_driver_i2c esp_lvgl_port
             esp_io_expander_tca9554 esp_lcd_co5300 esp_lcd_touch_cst816s
)

target_include_directories(${COMPONENT_LIB} PRIVATE "${TSX_BOARD_TARGET_GENERATED_DIR}")
