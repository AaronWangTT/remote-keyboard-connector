idf_component_register(SRCS "update_policy.c" "update_descriptor.c" "firmware_update.c"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES app_update device_identity board network usb_keyboard esp_timer esp_hw_support
                                     esp_hal_wdt esp_system spi_flash mbedtls bootloader_support)
execute_process(COMMAND git rev-parse HEAD WORKING_DIRECTORY "${PROJECT_DIR}"
                OUTPUT_VARIABLE source_commit OUTPUT_STRIP_TRAILING_WHITESPACE
                COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND git rev-parse --git-path HEAD WORKING_DIRECTORY "${PROJECT_DIR}"
                OUTPUT_VARIABLE head_path OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
get_filename_component(head_path "${head_path}" ABSOLUTE BASE_DIR "${PROJECT_DIR}")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${head_path}")
execute_process(COMMAND git symbolic-ref -q HEAD WORKING_DIRECTORY "${PROJECT_DIR}"
                OUTPUT_VARIABLE branch_ref OUTPUT_STRIP_TRAILING_WHITESPACE RESULT_VARIABLE detached)
if(NOT detached)
    execute_process(COMMAND git rev-parse --git-path "${branch_ref}" WORKING_DIRECTORY "${PROJECT_DIR}"
                    OUTPUT_VARIABLE branch_path OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
    get_filename_component(branch_path "${branch_path}" ABSOLUTE BASE_DIR "${PROJECT_DIR}")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${branch_path}")
endif()
idf_build_get_property(firmware_version PROJECT_VER)
target_compile_definitions(${COMPONENT_LIB} PRIVATE
                           FIRMWARE_SOURCE_COMMIT="${source_commit}"
                           FIRMWARE_VERSION="${firmware_version}")