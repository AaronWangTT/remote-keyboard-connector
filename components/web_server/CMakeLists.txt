idf_component_register(SRCS "web_server.c" "input_protocol.c" "access_control.c"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES esp_http_server esp_timer esp_netif esp_hw_support usb_keyboard device_identity network mbedtls
                       EMBED_TXTFILES "www/index.html" "www/app.css" "www/app.mjs" "www/keyboard.mjs"
                                      "www/icons/shift.svg" "www/icons/caps.svg" "www/icons/backspace.svg"
                                      "www/icons/return.svg" "www/icons/release.svg")
target_add_binary_data(${COMPONENT_LIB} "www/icons/settings.svg" TEXT)
target_add_binary_data(${COMPONENT_LIB} "www/icons/logout.svg" TEXT)
target_add_binary_data(${COMPONENT_LIB} "www/icons/eye.svg" TEXT)
target_add_binary_data(${COMPONENT_LIB} "www/icons/eye-off.svg" TEXT)
target_add_binary_data(${COMPONENT_LIB} "www/icons/back.svg" TEXT)
target_add_binary_data(${COMPONENT_LIB} "www/icons/refresh.svg" TEXT)
target_add_binary_data(${COMPONENT_LIB} "www/icons/globe.svg" TEXT)
target_add_binary_data(${COMPONENT_LIB} "www/icons/x.svg" TEXT)

idf_component_get_property(cjson_library espressif__cjson COMPONENT_LIB)
target_compile_definitions(${cjson_library} PRIVATE CJSON_NESTING_LIMIT=4)