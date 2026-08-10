idf_component_register(
    SRCS "waveshare_v1_wifi.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_event esp_netif esp_wifi freertos
)
