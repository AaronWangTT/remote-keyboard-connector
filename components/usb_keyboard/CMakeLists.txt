idf_component_register(SRCS "keyboard_state.c" "usb_keyboard.c"
                       INCLUDE_DIRS "include"
                       PRIV_INCLUDE_DIRS "."
                       PRIV_REQUIRES esp_timer esp_hw_support freertos)