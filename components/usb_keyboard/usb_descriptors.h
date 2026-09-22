#pragma once

#include "tusb.h"

static const uint8_t keyboard_report_descriptor[] = {
    TUD_HID_REPORT_DESC_KEYBOARD()
};

static const uint8_t keyboard_configuration_descriptor[] = {
    TUD_CONFIG_DESCRIPTOR(1, 1, 0, TUD_CONFIG_DESC_LEN + TUD_HID_DESC_LEN,
                          TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 500),
    TUD_HID_DESCRIPTOR(0, 4, HID_ITF_PROTOCOL_KEYBOARD,
                       sizeof(keyboard_report_descriptor), 0x81, 8, 10),
};

_Static_assert(sizeof(hid_keyboard_report_t) == 8, "Boot keyboard reports must be eight bytes");

static inline hid_keyboard_report_t keyboard_report(bool pressed)
{
    hid_keyboard_report_t report = {0};
    report.keycode[0] = pressed ? HID_KEY_A : 0;
    return report;
}