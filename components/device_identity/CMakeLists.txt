idf_component_register(SRCS "device_identity.c" "owner_store.c"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES nvs_flash esp_hw_support mbedtls)