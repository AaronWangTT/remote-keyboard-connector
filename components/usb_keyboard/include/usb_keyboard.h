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

esp_err_t usb_keyboard_start(void);
usb_keyboard_status_t usb_keyboard_status(void);
bool usb_keyboard_submit(uint32_t generation, const keyboard_report_t *report);
bool usb_keyboard_heartbeat(uint32_t generation);
void usb_keyboard_release(uint32_t generation);
bool usb_keyboard_quiescent(void);
bool usb_keyboard_begin_maintenance(void);
esp_err_t usb_keyboard_sleep(bool sleeping);
bool usb_keyboard_service_healthy(void);