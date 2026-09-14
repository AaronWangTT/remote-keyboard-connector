#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "keyboard_report.h"

#define INPUT_MESSAGE_MAX_BYTES 256

typedef enum {
    INPUT_INVALID,
    INPUT_STATE,
    INPUT_HEARTBEAT,
    INPUT_STOP,
} input_message_type_t;

typedef struct {
    input_message_type_t type;
    uint32_t sequence;
    keyboard_report_t report;
} input_message_t;

bool input_frame_valid(bool text, bool final, size_t length);
bool input_message_parse(const uint8_t *payload, size_t length, input_message_t *message);