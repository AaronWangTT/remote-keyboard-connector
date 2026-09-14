idf_component_register(SRCS "web_server.c" "input_protocol.c"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES esp_http_server esp_timer usb_keyboard
                       EMBED_TXTFILES "www/index.html" "www/app.css" "www/app.mjs" "www/keyboard.mjs"
                                      "www/icons/shift.svg" "www/icons/caps.svg" "www/icons/backspace.svg"
                                      "www/icons/return.svg" "www/icons/release.svg")

idf_component_get_property(cjson_library espressif__cjson COMPONENT_LIB)
target_compile_definitions(${cjson_library} PRIVATE CJSON_NESTING_LIMIT=4)