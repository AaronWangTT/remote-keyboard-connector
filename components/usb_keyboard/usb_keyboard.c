#include "usb_keyboard.h"

#include <stdio.h>
#include <string.h>

#include "esp_mac.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "keyboard_state.h"
#include "tinyusb.h"
#include "tinyusb_default_config.h"
#include "usb_descriptors.h"

static SemaphoreHandle_t state_mutex;
static keyboard_state_t keyboard;
static keyboard_report_t submitted_report;
static keyboard_report_t completed_report;
static bool leds_known;
static bool caps_lock;
static bool sleep_detached;
static bool awaiting_mount;
static int64_t worker_seen_at;
static char serial_number[13];
static const char *string_descriptors[] = {
    (const char[]){0x09, 0x04},
    "Remote Keyboard Prototype",
    "Wi-Fi Keyboard",
    serial_number,
    "Boot Keyboard",
};

static void set_usb_online(bool online, bool mounted)
{
    xSemaphoreTake(state_mutex, portMAX_DELAY);
    if (mounted && !sleep_detached) awaiting_mount = false;
    keyboard_state_usb(&keyboard, online && !sleep_detached && !awaiting_mount);
    leds_known = false;
    caps_lock = false;
    memset(&completed_report, 0, sizeof(completed_report));
    xSemaphoreGive(state_mutex);
}

static void usb_event(tinyusb_event_t *event, void *argument)
{
    (void)argument;
    bool attached = event->id == TINYUSB_EVENT_ATTACHED;
    set_usb_online(attached, attached);
}

void tud_suspend_cb(bool remote_wakeup_enabled)
{
    (void)remote_wakeup_enabled;
    set_usb_online(false, false);
}

void tud_resume_cb(void)
{
    set_usb_online(tud_mounted(), false);
}

const uint8_t *tud_hid_descriptor_report_cb(uint8_t instance)
{
    (void)instance;
    return keyboard_report_descriptor;
}

uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id,
                              hid_report_type_t report_type, uint8_t *buffer,
                              uint16_t requested_length)
{
    if (instance != 0 || report_id != 0 || report_type != HID_REPORT_TYPE_INPUT) {
        return 0;
    }
    uint16_t length = requested_length < sizeof(completed_report)
                      ? requested_length : sizeof(completed_report);
    xSemaphoreTake(state_mutex, portMAX_DELAY);
    memcpy(buffer, &completed_report, length);
    xSemaphoreGive(state_mutex);
    return length;
}

void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id,
                          hid_report_type_t report_type, const uint8_t *buffer,
                          uint16_t buffer_size)
{
    if (instance == 0 && report_id == 0 && report_type == HID_REPORT_TYPE_OUTPUT &&
        buffer != NULL && buffer_size == 1) {
        xSemaphoreTake(state_mutex, portMAX_DELAY);
        caps_lock = (buffer[0] & KEYBOARD_LED_CAPSLOCK) != 0;
        leds_known = true;
        xSemaphoreGive(state_mutex);
    }
}

void tud_hid_report_complete_cb(uint8_t instance, const uint8_t *report,
                               uint16_t length)
{
    xSemaphoreTake(state_mutex, portMAX_DELAY);
    if (instance == 0 && length == sizeof(submitted_report) && keyboard.in_flight &&
        memcmp(report, &submitted_report, length) == 0) {
        completed_report = submitted_report;
        keyboard_state_complete(&keyboard);
    }
    xSemaphoreGive(state_mutex);
}

void tud_hid_report_failed_cb(uint8_t instance, hid_report_type_t report_type,
                             const uint8_t *report, uint16_t transferred_bytes)
{
    (void)report;
    (void)transferred_bytes;
    if (instance == 0 && report_type == HID_REPORT_TYPE_INPUT) {
        xSemaphoreTake(state_mutex, portMAX_DELAY);
        keyboard_state_submit_failed(&keyboard);
        xSemaphoreGive(state_mutex);
    }
}

static void keyboard_worker(void *argument)
{
    (void)argument;
    for (;;) {
        xSemaphoreTake(state_mutex, portMAX_DELAY);
        bool online = tud_mounted() && !tud_suspended() && !sleep_detached && !awaiting_mount;
        if (keyboard.online != online) {
            keyboard_state_usb(&keyboard, online);
            leds_known = false;
            caps_lock = false;
            memset(&completed_report, 0, sizeof(completed_report));
        }
        int64_t now = esp_timer_get_time();
        worker_seen_at = now;
        keyboard_state_tick(&keyboard, now);
        if (online && tud_hid_ready() && keyboard_state_next(&keyboard, now, &submitted_report)) {
            if (!tud_hid_report(0, &submitted_report, sizeof(submitted_report))) {
                keyboard_state_submit_failed(&keyboard);
            }
        }
        xSemaphoreGive(state_mutex);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

usb_keyboard_status_t usb_keyboard_status(void)
{
    xSemaphoreTake(state_mutex, portMAX_DELAY);
    keyboard_state_tick(&keyboard, esp_timer_get_time());
    usb_keyboard_status_t status = {
        .ready = keyboard_state_ready(&keyboard),
        .generation = keyboard.generation,
        .leds_known = leds_known,
        .caps_lock = caps_lock,
    };
    xSemaphoreGive(state_mutex);
    return status;
}

bool usb_keyboard_submit(uint32_t generation, const keyboard_report_t *report)
{
    xSemaphoreTake(state_mutex, portMAX_DELAY);
    bool accepted = keyboard_state_input(&keyboard, generation, report, esp_timer_get_time());
    xSemaphoreGive(state_mutex);
    return accepted;
}

bool usb_keyboard_heartbeat(uint32_t generation)
{
    xSemaphoreTake(state_mutex, portMAX_DELAY);
    bool accepted = keyboard_state_heartbeat(&keyboard, generation, esp_timer_get_time());
    xSemaphoreGive(state_mutex);
    return accepted;
}

void usb_keyboard_release(uint32_t generation)
{
    xSemaphoreTake(state_mutex, portMAX_DELAY);
    if (generation == keyboard.generation) {
        keyboard_state_release(&keyboard);
    }
    xSemaphoreGive(state_mutex);
}

bool usb_keyboard_begin_maintenance(void)
{
    if (state_mutex == NULL || xSemaphoreTake(state_mutex, pdMS_TO_TICKS(25)) != pdTRUE) return false;
    keyboard_state_release(&keyboard);
    xSemaphoreGive(state_mutex);
    return true;
}

static bool keyboard_quiescent_locked(void)
{
    const keyboard_report_t empty = {0};
    return !keyboard.online || (!keyboard.neutral_pending && !keyboard.in_flight && keyboard.count == 0 &&
        memcmp(&completed_report, &empty, sizeof(empty)) == 0 && memcmp(&keyboard.desired_report, &empty, sizeof(empty)) == 0);
}

bool usb_keyboard_quiescent(void)
{
    if (state_mutex == NULL || xSemaphoreTake(state_mutex, pdMS_TO_TICKS(25)) != pdTRUE) return false;
    keyboard_state_tick(&keyboard, esp_timer_get_time());
    bool released = keyboard_quiescent_locked();
    xSemaphoreGive(state_mutex);
    return released;
}

esp_err_t usb_keyboard_sleep(bool sleeping)
{
    if (state_mutex == NULL || xSemaphoreTake(state_mutex, pdMS_TO_TICKS(25)) != pdTRUE) return ESP_ERR_TIMEOUT;
    esp_err_t result = ESP_ERR_INVALID_STATE;
    if (!sleeping || keyboard_quiescent_locked()) {
        bool changed = sleeping ? tud_disconnect() : tud_connect();
        result = changed ? ESP_OK : ESP_FAIL;
        if (changed) {
            sleep_detached = sleeping;
            awaiting_mount = true;
            keyboard_state_usb(&keyboard, false);
            leds_known = caps_lock = false;
            memset(&completed_report, 0, sizeof(completed_report));
        }
    }
    xSemaphoreGive(state_mutex);
    return result;
}

bool usb_keyboard_service_healthy(void)
{
    if (state_mutex == NULL || xSemaphoreTake(state_mutex, pdMS_TO_TICKS(25)) != pdTRUE) return false;
    bool healthy = worker_seen_at != 0 && esp_timer_get_time() - worker_seen_at < INT64_C(1000000);
    xSemaphoreGive(state_mutex);
    return healthy;
}

esp_err_t usb_keyboard_start(void)
{
    if (state_mutex != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    uint8_t device_mac[6];
    esp_err_t result = esp_efuse_mac_get_default(device_mac);
    if (result != ESP_OK) {
        return result;
    }
    snprintf(serial_number, sizeof(serial_number), "%02x%02x%02x%02x%02x%02x",
             device_mac[0], device_mac[1], device_mac[2],
             device_mac[3], device_mac[4], device_mac[5]);
    state_mutex = xSemaphoreCreateMutex();
    if (state_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }
    keyboard_state_init(&keyboard);
    tinyusb_config_t configuration = TINYUSB_DEFAULT_CONFIG();
    configuration.descriptor.full_speed_config = keyboard_configuration_descriptor;
    configuration.descriptor.string = string_descriptors;
    configuration.descriptor.string_count = sizeof(string_descriptors) / sizeof(string_descriptors[0]);
    configuration.event_cb = usb_event;
    result = tinyusb_driver_install(&configuration);
    if (result == ESP_OK && xTaskCreate(keyboard_worker, "keyboard", 3072, NULL, 5, NULL) != pdPASS) {
        tinyusb_driver_uninstall();
        result = ESP_ERR_NO_MEM;
    }
    if (result != ESP_OK) {
        vSemaphoreDelete(state_mutex);
        state_mutex = NULL;
    }
    return result;
}