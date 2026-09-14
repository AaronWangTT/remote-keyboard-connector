idf_component_register(SRCS "network.c" "network_state.c"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES esp_wifi esp_netif esp_event esp_timer nvs_flash usb_keyboard device_identity mbedtls)