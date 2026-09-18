idf_component_register(SRCS "board_status.c" "board_status_logic.c" "board_power_policy.c" "board_power.c"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES esp_driver_gpio esp_timer esp_hw_support nvs_flash)