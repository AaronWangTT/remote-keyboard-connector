#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "keyboard_report.h"

typedef struct {
    bool ready;
    uint32_t generation;
    bool leds_known;
    bool caps_lock;
} usb_keyboard_status_t;

typedef enum {
    USB_KEYBOARD_WAKE_NONE,
    USB_KEYBOARD_WAKE_PENDING,
    USB_KEYBOARD_WAKE_DELIVERED,
    USB_KEYBOARD_WAKE_FAILED,
} usb_keyboard_wake_state_t;

typedef struct {
    uint32_t request_id;
    usb_keyboard_wake_state_t state;
    bool remote_wakeup_sent;
    bool usb_active;
} usb_keyboard_wake_status_t;

esp_err_t usb_keyboard_start(void);
usb_keyboard_status_t usb_keyboard_status(void);
bool usb_keyboard_submit(uint32_t generation, const keyboard_report_t *report);
bool usb_keyboard_heartbeat(uint32_t generation);
void usb_keyboard_release(uint32_t generation);
esp_err_t usb_keyboard_wakeup_begin(uint32_t *request_id);
usb_keyboard_wake_status_t usb_keyboard_wakeup_status(uint32_t request_id);
void usb_keyboard_wakeup_finish(uint32_t request_id);
bool usb_keyboard_quiescent(void);
bool usb_keyboard_begin_maintenance(void);
esp_err_t usb_keyboard_sleep(bool sleeping);
bool usb_keyboard_service_healthy(void);