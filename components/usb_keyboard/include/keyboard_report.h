#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define KEYBOARD_KEY_CAPACITY 6

typedef struct {
    uint8_t modifiers;
    uint8_t reserved;
    uint8_t keys[KEYBOARD_KEY_CAPACITY];
} keyboard_report_t;

_Static_assert(sizeof(keyboard_report_t) == 8, "Keyboard report must be eight bytes");

bool keyboard_report_build(keyboard_report_t *report, uint8_t modifiers,
                            const uint8_t *keys, size_t count);
bool keyboard_report_valid(const keyboard_report_t *report);
bool keyboard_report_empty(const keyboard_report_t *report);