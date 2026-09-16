#include "firmware_update.h"

#include <stdio.h>
#include <string.h>
#include "esp_flash.h"
#include "esp_image_format.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal/wdt_hal.h"
#include "network.h"
#include "psa/crypto.h"
#include "sdkconfig.h"
#include "usb_keyboard.h"

#if !CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT || !CONFIG_SECURE_SIGNED_APPS_RSA_SCHEME || !CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE
#error "OTA requires the committed signed-app and rollback configuration; configure a fresh build"
#endif

static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static firmware_update_status_t status;
static bool worker_active;
static bool network_held;
static bool initialized;
static bool handle_open;
static esp_ota_handle_t handle;
static const esp_partition_t *target;
static psa_hash_operation_t hash = PSA_HASH_OPERATION_INIT;
static bool (*health_probe)(void);
static TaskHandle_t boot_task;
static esp_timer_handle_t restart_timer;

static void restart_callback(void *argument)
{
    (void)argument;
    esp_restart();
}

static void stop_boot_watchdog(void)
{
    wdt_hal_context_t watchdog = RWDT_HAL_CONTEXT_DEFAULT();
    wdt_hal_write_protect_disable(&watchdog);
    wdt_hal_disable(&watchdog);
    wdt_hal_write_protect_enable(&watchdog);
}

esp_err_t firmware_update_init(void)
{
    if (initialized || !update_descriptor_valid(firmware_update_descriptor())) return ESP_ERR_INVALID_STATE;
    uint32_t flash_bytes = 0;
    if (esp_flash_get_size(NULL, &flash_bytes) != ESP_OK || flash_bytes < 0x1000000) return ESP_ERR_INVALID_SIZE;
    const struct { const char *name; esp_partition_type_t type; esp_partition_subtype_t subtype; uint32_t offset; uint32_t size; } expected[] = {
        {"nvs", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, 0x9000, 0x10000},
        {"otadata", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_OTA, 0x19000, 0x2000},
        {"ota_0", ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, 0x20000, UPDATE_SLOT_BYTES},
        {"ota_1", ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_1, 0x620000, UPDATE_SLOT_BYTES},
    };
    for (size_t index = 0; index < sizeof(expected) / sizeof(expected[0]); index++) {
        const esp_partition_t *partition = esp_partition_find_first(expected[index].type, expected[index].subtype, expected[index].name);
        if (partition == NULL || partition->address != expected[index].offset || partition->size != expected[index].size || partition->encrypted) {
            return ESP_ERR_INVALID_STATE;
        }
    }
    esp_ota_img_states_t state;
    esp_err_t result = esp_ota_get_state_partition(esp_ota_get_running_partition(), &state);
    if (result != ESP_OK) return result;
    if (state != ESP_OTA_IMG_VALID && state != ESP_OTA_IMG_PENDING_VERIFY) return ESP_ERR_INVALID_STATE;
    status.trial_boot = state == ESP_OTA_IMG_PENDING_VERIFY;
    if (!status.trial_boot) stop_boot_watchdog();
    const esp_timer_create_args_t timer = {.callback = restart_callback, .name = "ota_restart"};
    result = esp_timer_create(&timer, &restart_timer);
    initialized = result == ESP_OK;
    return result;
}

static void validate_boot(void *argument)
{
    (void)argument;
    int64_t deadline = esp_timer_get_time() + INT64_C(45000000);
    unsigned healthy_samples = 0;
    while (esp_timer_get_time() < deadline) {
        healthy_samples = health_probe() ? healthy_samples + 1 : 0;
        if (healthy_samples >= 8 && esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
            stop_boot_watchdog();
            portENTER_CRITICAL(&lock);
            status.available = true;
            status.trial_boot = false;
            portEXIT_CRITICAL(&lock);
            ESP_LOGI("ota", "Boot validation passed; updates available on AP or station");
            vTaskDelete(NULL);
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    ESP_LOGE("ota", "Boot validation failed; retaining settings and requesting rollback");
    esp_ota_mark_app_invalid_rollback_and_reboot();
    esp_restart();
}

esp_err_t firmware_update_validate_boot(bool (*healthy)(void))
{
    if (!initialized || healthy == NULL || boot_task != NULL || firmware_update_status().available) return ESP_ERR_INVALID_STATE;
    if (!status.trial_boot) {
        portENTER_CRITICAL(&lock);
        status.available = true;
        portEXIT_CRITICAL(&lock);
        return ESP_OK;
    }
    health_probe = healthy;
    return xTaskCreate(validate_boot, "ota_boot", 4096, NULL, 2, &boot_task) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

firmware_update_status_t firmware_update_status(void)
{
    portENTER_CRITICAL(&lock);
    firmware_update_status_t result = status;
    result.busy = worker_active || update_policy_busy(&status.policy);
    portEXIT_CRITICAL(&lock);
    return result;
}

static void release_network_if_done(void)
{
    portENTER_CRITICAL(&lock);
    bool release = network_held && !worker_active && !update_policy_busy(&status.policy);
    if (release) network_held = false;
    portEXIT_CRITICAL(&lock);
    if (release) network_update_end();
}

void firmware_update_fail(uint32_t job_id, const char *error)
{
    portENTER_CRITICAL(&lock);
    if (status.policy.job_id == job_id && status.policy.phase != UPDATE_ACTIVATING && status.policy.phase != UPDATE_CANCELLED) {
        status.policy.phase = UPDATE_FAILED;
        snprintf(status.error, sizeof(status.error), "%s", error);
    }
    portEXIT_CRITICAL(&lock);
    release_network_if_done();
}

esp_err_t firmware_update_reserve(size_t bytes, uint32_t local_address, uint32_t *job_id)
{
    if (job_id == NULL || !update_image_size_valid(bytes)) return ESP_ERR_INVALID_SIZE;
    portENTER_CRITICAL(&lock);
    bool accepted = status.available && !worker_active && update_policy_begin(&status.policy, bytes, esp_timer_get_time());
    if (accepted) {
        worker_active = true;
        status.candidate_version[0] = status.digest[0] = status.error[0] = '\0';
        *job_id = status.policy.job_id;
    }
    portEXIT_CRITICAL(&lock);
    if (!accepted) return ESP_ERR_INVALID_STATE;
    if (!network_update_begin(local_address)) {
        firmware_update_fail(*job_id, "network_busy");
        firmware_update_worker_done(*job_id);
        return ESP_ERR_INVALID_STATE;
    }
    portENTER_CRITICAL(&lock);
    network_held = true;
    portEXIT_CRITICAL(&lock);
    return ESP_OK;
}

esp_err_t firmware_update_open(uint32_t job_id)
{
    firmware_update_status_t current = firmware_update_status();
    if (current.policy.job_id != job_id || current.policy.phase != UPDATE_RECEIVING) return ESP_ERR_INVALID_STATE;
    if (!usb_keyboard_begin_maintenance()) return ESP_ERR_TIMEOUT;
    int64_t deadline = esp_timer_get_time() + INT64_C(2000000);
    while (!usb_keyboard_quiescent()) {
        if (esp_timer_get_time() >= deadline) return ESP_ERR_TIMEOUT;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    current = firmware_update_status();
    if (current.policy.job_id != job_id || current.policy.phase != UPDATE_RECEIVING ||
        update_policy_expired(&current.policy, esp_timer_get_time())) return ESP_ERR_INVALID_STATE;
    target = esp_ota_get_next_update_partition(NULL);
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (target == NULL || running == NULL || target->address == running->address || target->size != UPDATE_SLOT_BYTES ||
        (target->address != 0x20000 && target->address != 0x620000)) return ESP_ERR_INVALID_STATE;
    esp_err_t result = esp_ota_begin(target, current.policy.expected, &handle);
    handle_open = result == ESP_OK;
    if (result == ESP_OK && psa_hash_setup(&hash, PSA_ALG_SHA_256) != PSA_SUCCESS) return ESP_FAIL;
    return result;
}

esp_err_t firmware_update_write(uint32_t job_id, const uint8_t *data, size_t bytes)
{
    portENTER_CRITICAL(&lock);
    bool accepted = status.policy.job_id == job_id && update_policy_write(&status.policy, bytes, esp_timer_get_time());
    portEXIT_CRITICAL(&lock);
    if (!accepted || !handle_open || data == NULL) return ESP_ERR_INVALID_STATE;
    esp_err_t result = esp_ota_write(handle, data, bytes);
    if (result == ESP_OK && psa_hash_update(&hash, data, bytes) != PSA_SUCCESS) result = ESP_FAIL;
    return result;
}

static bool signature_framing_valid(size_t bytes)
{
    uint8_t block[256];
    if (esp_partition_read(target, bytes - 4096, block, 2) != ESP_OK || block[0] != 0xe7 || block[1] != 2) return false;
    for (size_t offset = 1216; offset < 4096;) {
        size_t count = 4096 - offset < sizeof(block) ? 4096 - offset : sizeof(block);
        if (esp_partition_read(target, bytes - 4096 + offset, block, count) != ESP_OK) return false;
        for (size_t index = 0; index < count; index++) if (block[index] != 0xff) return false;
        offset += count;
    }
    return true;
}

esp_err_t firmware_update_finish(uint32_t job_id)
{
    portENTER_CRITICAL(&lock);
    bool accepted = status.policy.job_id == job_id && update_policy_verify(&status.policy, esp_timer_get_time());
    size_t expected = status.policy.expected;
    portEXIT_CRITICAL(&lock);
    if (!accepted || !handle_open) return ESP_ERR_INVALID_STATE;
    esp_err_t result = esp_ota_end(handle);
    handle_open = false;
    if (result != ESP_OK) return result;
    const esp_partition_pos_t position = {.offset = target->address, .size = expected};
    esp_image_metadata_t metadata;
    if (esp_image_verify(ESP_IMAGE_VERIFY_SILENT, &position, &metadata) != ESP_OK || metadata.image_len != expected) {
        return ESP_ERR_INVALID_SIZE;
    }
    update_descriptor_t candidate;
    esp_app_desc_t application;
    if (!signature_framing_valid(expected) ||
        esp_partition_read(target, UPDATE_DESCRIPTOR_OFFSET, &candidate, sizeof(candidate)) != ESP_OK ||
        !update_descriptor_compatible(&candidate, firmware_update_descriptor()) ||
        esp_ota_get_partition_description(target, &application) != ESP_OK ||
        strncmp(application.version, candidate.version, sizeof(application.version)) != 0 ||
        memcmp(application.project_name, esp_app_get_description()->project_name, sizeof(application.project_name)) != 0) {
        return ESP_ERR_INVALID_VERSION;
    }
    uint8_t digest[32];
    size_t length = 0;
    if (psa_hash_finish(&hash, digest, sizeof(digest), &length) != PSA_SUCCESS || length != sizeof(digest)) return ESP_FAIL;
    portENTER_CRITICAL(&lock);
    accepted = status.policy.job_id == job_id && update_policy_stage(&status.policy, esp_timer_get_time());
    if (accepted) {
        memcpy(status.candidate_version, candidate.version, sizeof(status.candidate_version));
        static const char hex[] = "0123456789abcdef";
        for (size_t index = 0; index < sizeof(digest); index++) {
            status.digest[index * 2] = hex[digest[index] >> 4];
            status.digest[index * 2 + 1] = hex[digest[index] & 15];
        }
        status.digest[64] = '\0';
    }
    portEXIT_CRITICAL(&lock);
    return accepted ? ESP_OK : ESP_ERR_INVALID_STATE;
}

void firmware_update_worker_done(uint32_t job_id)
{
    portENTER_CRITICAL(&lock);
    bool current = worker_active && status.policy.job_id == job_id;
    portEXIT_CRITICAL(&lock);
    if (!current) return;
    if (handle_open) {
        esp_ota_abort(handle);
        handle_open = false;
    }
    psa_hash_abort(&hash);
    portENTER_CRITICAL(&lock);
    if (status.policy.job_id == job_id) worker_active = false;
    portEXIT_CRITICAL(&lock);
    release_network_if_done();
}

bool firmware_update_cancel(uint32_t job_id)
{
    portENTER_CRITICAL(&lock);
    bool cancelled = update_policy_cancel(&status.policy, job_id);
    if (cancelled) snprintf(status.error, sizeof(status.error), "cancelled");
    portEXIT_CRITICAL(&lock);
    release_network_if_done();
    return cancelled;
}

void firmware_update_tick(void)
{
    portENTER_CRITICAL(&lock);
    if (update_policy_expired(&status.policy, esp_timer_get_time())) {
        status.policy.phase = UPDATE_FAILED;
        snprintf(status.error, sizeof(status.error), "update_timeout");
    }
    portEXIT_CRITICAL(&lock);
    release_network_if_done();
}

esp_err_t firmware_update_activate(uint32_t job_id, const char *digest)
{
    portENTER_CRITICAL(&lock);
    bool accepted = !worker_active && digest != NULL && strlen(digest) == 64 && strcmp(status.digest, digest) == 0 &&
        update_policy_activate(&status.policy, job_id, esp_timer_get_time());
    portEXIT_CRITICAL(&lock);
    if (!accepted) return ESP_ERR_INVALID_STATE;
    esp_err_t result = esp_ota_set_boot_partition(target);
    if (result != ESP_OK) {
        portENTER_CRITICAL(&lock);
        status.policy.phase = UPDATE_FAILED;
        snprintf(status.error, sizeof(status.error), "activation_failed");
        portEXIT_CRITICAL(&lock);
        release_network_if_done();
    }
    return result;
}

void firmware_update_restart(void)
{
    if (firmware_update_status().policy.phase == UPDATE_ACTIVATING && esp_timer_start_once(restart_timer, 200000) != ESP_OK) esp_restart();
}