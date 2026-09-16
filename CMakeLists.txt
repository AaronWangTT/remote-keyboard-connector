cmake_minimum_required(VERSION 3.22)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(MINIMAL_BUILD ON)
if(NOT DEFINED PROJECT_VER)
	set(PROJECT_VER "0.1.0")
endif()
idf_build_get_property(idf_python PYTHON)
execute_process(COMMAND "${idf_python}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/prepare-build.py"
				"${CMAKE_CURRENT_SOURCE_DIR}/.cache/ota-test-signing-key.pem"
				COMMAND_ERROR_IS_FATAL ANY)
project(esp32s3_starter)

add_custom_target(firmware_artifacts ALL
		  COMMAND "${idf_python}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ota_artifacts.py"
			  --build "${CMAKE_BINARY_DIR}" --idf-path "$ENV{IDF_PATH}"
		  DEPENDS gen_project_binary bootloader partition_table_bin blank_ota_data
		  VERBATIM)