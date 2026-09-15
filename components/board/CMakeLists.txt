idf_component_register(SRCS "board_status.c" "board_status_logic.c"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES esp_driver_gpio esp_timer)