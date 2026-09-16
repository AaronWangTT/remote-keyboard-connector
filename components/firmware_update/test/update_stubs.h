#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT 1
#define CONFIG_SECURE_SIGNED_APPS_RSA_SCHEME 1
#define CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE 1
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_INVALID_ARG 1
#define ESP_ERR_INVALID_SIZE 2
#define ESP_ERR_INVALID_STATE 3
#define ESP_ERR_TIMEOUT 4
#define ESP_ERR_NO_MEM 5
#define ESP_ERR_INVALID_VERSION 6
#define ESP_ERR_NOT_FOUND 7
#define ESP_PARTITION_TYPE_APP 0
#define ESP_PARTITION_TYPE_DATA 1
#define ESP_PARTITION_SUBTYPE_DATA_NVS 2
#define ESP_PARTITION_SUBTYPE_DATA_OTA 0
#define ESP_PARTITION_SUBTYPE_DATA_PHY 1
#define ESP_PARTITION_SUBTYPE_APP_OTA_0 16
#define ESP_PARTITION_SUBTYPE_APP_OTA_1 17
#define ESP_OTA_IMG_NEW 0
#define ESP_OTA_IMG_PENDING_VERIFY 1
#define ESP_OTA_IMG_VALID 2
#define ESP_OTA_IMG_INVALID 3
#define ESP_OTA_IMG_ABORTED 4
#define FACTORY_INDEX -1
#define INVALID_INDEX -99
#define FLASH_SECTOR_SIZE 4096
#define ESP_IMAGE_VERIFY_SILENT 1
#define portMUX_INITIALIZER_UNLOCKED 0
#define pdPASS 1
#define pdMS_TO_TICKS(value) (value)
#define PSA_HASH_OPERATION_INIT {0}
#define PSA_ALG_SHA_256 1
#define PSA_SUCCESS 0
#define RWDT_HAL_CONTEXT_DEFAULT() {0}
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGD(...) ((void)0)
#define ESP_LOGE(...) ((void)0)

typedef int esp_err_t;
typedef int portMUX_TYPE;
typedef int esp_partition_type_t;
typedef int esp_partition_subtype_t;
typedef int esp_ota_img_states_t;
typedef uint32_t esp_ota_handle_t;
typedef void *TaskHandle_t;
typedef void *esp_timer_handle_t;
typedef struct { unsigned active; } psa_hash_operation_t;
typedef struct { unsigned unused; } wdt_hal_context_t;
typedef struct { void (*callback)(void *); const char *name; } esp_timer_create_args_t;
typedef struct {
	uint32_t address;
	uint32_t size;
	bool encrypted;
	esp_partition_type_t type;
	esp_partition_subtype_t subtype;
	char label[17];
} esp_partition_t;
typedef struct { char version[32]; char project_name[32]; } esp_app_desc_t;
typedef struct { uint32_t offset; size_t size; } esp_partition_pos_t;
typedef struct { uint32_t ota_seq; uint8_t seq_label[20]; uint32_t ota_state; uint32_t crc; } esp_ota_select_entry_t;
typedef struct { esp_partition_pos_t ota_info; esp_partition_pos_t factory; unsigned app_count; } bootloader_state_t;
typedef struct { size_t image_len; } esp_image_metadata_t;
esp_err_t esp_image_verify(int mode, const esp_partition_pos_t *position, esp_image_metadata_t *metadata);

void test_update_enter(portMUX_TYPE *mutex);
void test_update_exit(portMUX_TYPE *mutex);
#define portENTER_CRITICAL(mutex) test_update_enter(mutex)
#define portEXIT_CRITICAL(mutex) test_update_exit(mutex)
int64_t esp_timer_get_time(void);
esp_err_t esp_timer_create(const esp_timer_create_args_t *args, esp_timer_handle_t *timer);
esp_err_t esp_timer_start_once(esp_timer_handle_t timer, uint64_t delay);
int xTaskCreate(void (*entry)(void *), const char *name, uint32_t stack, void *argument, unsigned priority, TaskHandle_t *task);
void vTaskDelay(unsigned ticks);
void vTaskDelete(void *task);
void esp_restart(void);
void wdt_hal_write_protect_disable(wdt_hal_context_t *context);
void wdt_hal_disable(wdt_hal_context_t *context);
void wdt_hal_write_protect_enable(wdt_hal_context_t *context);
esp_err_t esp_flash_get_size(void *chip, uint32_t *size);
const esp_partition_t *esp_partition_find_first(int type, int subtype, const char *name);
esp_err_t esp_partition_read(const esp_partition_t *partition, size_t offset, void *data, size_t bytes);
const esp_partition_t *esp_ota_get_running_partition(void);
const esp_partition_t *esp_ota_get_next_update_partition(void *start);
esp_err_t esp_ota_get_state_partition(const esp_partition_t *partition, esp_ota_img_states_t *state);
esp_err_t esp_ota_mark_app_valid_cancel_rollback(void);
esp_err_t esp_ota_mark_app_invalid_rollback_and_reboot(void);
esp_err_t esp_ota_begin(const esp_partition_t *partition, size_t bytes, esp_ota_handle_t *handle);
esp_err_t esp_ota_write(esp_ota_handle_t handle, const void *data, size_t bytes);
esp_err_t esp_ota_end(esp_ota_handle_t handle);
esp_err_t esp_ota_abort(esp_ota_handle_t handle);
esp_err_t esp_ota_get_partition_description(const esp_partition_t *partition, esp_app_desc_t *description);
const esp_app_desc_t *esp_app_get_description(void);
esp_err_t esp_ota_set_boot_partition(const esp_partition_t *partition);
int psa_hash_setup(psa_hash_operation_t *operation, int algorithm);
int psa_hash_update(psa_hash_operation_t *operation, const uint8_t *data, size_t bytes);
int psa_hash_finish(psa_hash_operation_t *operation, uint8_t *digest, size_t capacity, size_t *length);
int psa_hash_abort(psa_hash_operation_t *operation);