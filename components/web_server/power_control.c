#include "power_control.h"

#include <string.h>
#include "board_power.h"
#include "cJSON.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "firmware_update.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "network.h"
#include "usb_keyboard.h"

static power_control_status_t power_status;
static board_power_policy_t policy;
static int64_t wake_released_at;
static portMUX_TYPE worker_lock = portMUX_INITIALIZER_UNLOCKED;
static bool worker_finished;

void power_control_init(void)
{
    power_status = (power_control_status_t){.supported = board_power_supported(),
        .idle_minutes = BOARD_POWER_DEFAULT_IDLE_MINUTES, .error = ""};
    if (!power_status.supported) return;
    esp_err_t result = board_power_init();
    if (result == ESP_OK) result = board_power_load_timeout(&power_status.idle_minutes);
    power_status.available = result == ESP_OK;
    if (result != ESP_OK) {
        power_status.error = "power_initialization_failed";
        ESP_LOGW("power", "Automatic sleep unavailable (%s)", esp_err_to_name(result));
    }
    board_power_policy_configure(&policy, power_status.idle_minutes, esp_timer_get_time());
}

power_control_status_t power_control_status(void)
{
    return power_status;
}

void power_control_activity(void)
{
    if (power_status.available && !power_status.preparing) board_power_policy_activity(&policy, esp_timer_get_time());
}

esp_err_t power_control_configure(uint32_t idle_minutes)
{
    if (!board_power_timeout_valid(idle_minutes)) return ESP_ERR_INVALID_ARG;
    if (!power_status.supported) return ESP_ERR_NOT_SUPPORTED;
    if (!power_status.available || power_status.preparing) return ESP_ERR_INVALID_STATE;
    esp_err_t result = idle_minutes == power_status.idle_minutes ? ESP_OK : board_power_save_timeout(idle_minutes);
    if (result == ESP_OK) {
        power_status.idle_minutes = idle_minutes;
        board_power_policy_configure(&policy, idle_minutes, esp_timer_get_time());
    } else {
        power_status.available = false;
        power_status.error = "power_storage_failed";
    }
    return result;
}

bool power_control_parse_request(const uint8_t *payload, size_t length, uint32_t *idle_minutes)
{
    if (payload == NULL || idle_minutes == NULL || length == 0 || length > 128 || memchr(payload, '\0', length) != NULL) return false;
    char body[129];
    memcpy(body, payload, length);
    body[length] = '\0';
    for (size_t index = 0; index < length; index++) {
        if (body[index] != '\\') continue;
        if (index + 6 <= length && memcmp(body + index, "\\u0000", 6) == 0) return false;
        index++;
    }
    cJSON *root = cJSON_ParseWithLengthOpts(body, length + 1, NULL, true);
    cJSON *timeout = cJSON_GetObjectItemCaseSensitive(root, "idle_minutes");
    bool valid = cJSON_IsObject(root) && cJSON_GetArraySize(root) == 1 && cJSON_IsNumber(timeout) &&
        (timeout->valuedouble == 0 || timeout->valuedouble == 30 || timeout->valuedouble == 60);
    if (valid) *idle_minutes = (uint32_t)timeout->valuedouble;
    cJSON_Delete(root);
    return valid;
}

static void sleep_worker(void *argument)
{
    (void)argument;
    bool detached = false;
    esp_err_t result = board_power_prepare_sleep();
    if (result == ESP_OK && !usb_keyboard_begin_maintenance()) result = ESP_ERR_TIMEOUT;
    int64_t deadline = esp_timer_get_time() + INT64_C(2000000);
    while (result == ESP_OK && !usb_keyboard_quiescent()) {
        if (esp_timer_get_time() >= deadline) { result = ESP_ERR_TIMEOUT; break; }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (result == ESP_OK && !network_sleep_stop()) result = ESP_ERR_INVALID_STATE;
    deadline = esp_timer_get_time() + INT64_C(3000000);
    while (result == ESP_OK && network_sleep_state() != NETWORK_SLEEP_STOPPED) {
        if (network_sleep_state() == NETWORK_SLEEP_FAILED || esp_timer_get_time() >= deadline) {
            result = ESP_ERR_TIMEOUT;
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(25));
    }
    if (result == ESP_OK) {
        result = usb_keyboard_sleep(true);
        detached = result == ESP_OK;
    }
    if (result == ESP_OK) result = board_power_enter_sleep();
    esp_err_t restored = board_power_cancel_sleep();
    if (detached) {
        esp_err_t usb_result = usb_keyboard_sleep(false);
        if (restored == ESP_OK) restored = usb_result;
    }
    network_sleep_end();
    ESP_LOGW("power", "Automatic sleep aborted (%s); restoration %s; input stays disarmed",
        esp_err_to_name(result), esp_err_to_name(restored));
    portENTER_CRITICAL(&worker_lock);
    worker_finished = true;
    portEXIT_CRITICAL(&worker_lock);
    vTaskDelete(NULL);
}

void power_control_poll(bool owner_ready, bool pending_control, void (*release_control)(void))
{
    if (!power_status.available) return;
    if (power_status.preparing) {
        portENTER_CRITICAL(&worker_lock);
        bool finished = worker_finished;
        portEXIT_CRITICAL(&worker_lock);
        if (finished && network_sleep_state() == NETWORK_SLEEP_AWAKE) {
            power_status.preparing = false;
            power_status.available = false;
            power_status.error = "sleep_failed";
        }
        return;
    }
    int64_t now = esp_timer_get_time();
    if (!board_power_wake_released()) wake_released_at = 0;
    else if (wake_released_at == 0) wake_released_at = now;
    bool wake_ready = wake_released_at != 0 && now - wake_released_at >= INT64_C(50000);
    firmware_update_status_t update = firmware_update_status();
    bool blocked = !owner_ready || pending_control || !update.available || update.trial_boot || update.busy ||
        network_sleep_blocked() || !usb_keyboard_quiescent() || !wake_ready;
    if (!board_power_policy_due(&policy, now, blocked) || !network_control_status(0).ready) return;
    release_control();
    if (!network_sleep_begin()) {
        power_control_activity();
        return;
    }
    power_status.preparing = true;
    portENTER_CRITICAL(&worker_lock);
    worker_finished = false;
    portEXIT_CRITICAL(&worker_lock);
    if (xTaskCreate(sleep_worker, "board_sleep", 4096, NULL, 2, NULL) != pdPASS) {
        network_sleep_end();
        power_status.preparing = false;
        power_status.available = false;
        power_status.error = "sleep_worker_failed";
    }
}
