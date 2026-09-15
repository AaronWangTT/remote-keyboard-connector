#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

static inline size_t network_utf8_sequence_length(const uint8_t *value, size_t length)
{
    if (length != 0 && value[0] < 0x80) return 1;
    if (length >= 2 && value[0] >= 0xc2 && value[0] <= 0xdf && (value[1] & 0xc0) == 0x80) return 2;
    if (length >= 3 && ((value[0] == 0xe0 && value[1] >= 0xa0 && value[1] <= 0xbf) ||
        ((value[0] >= 0xe1 && value[0] <= 0xec) && (value[1] & 0xc0) == 0x80) ||
        (value[0] == 0xed && value[1] >= 0x80 && value[1] <= 0x9f) ||
        ((value[0] >= 0xee && value[0] <= 0xef) && (value[1] & 0xc0) == 0x80)) &&
        (value[2] & 0xc0) == 0x80) return 3;
    if (length >= 4 && ((value[0] == 0xf0 && value[1] >= 0x90 && value[1] <= 0xbf) ||
        ((value[0] >= 0xf1 && value[0] <= 0xf3) && (value[1] & 0xc0) == 0x80) ||
        (value[0] == 0xf4 && value[1] >= 0x80 && value[1] <= 0x8f)) &&
        (value[2] & 0xc0) == 0x80 && (value[3] & 0xc0) == 0x80) return 4;
    return 0;
}

static inline bool network_utf8_valid(const uint8_t *value, size_t length)
{
    if (value == NULL) return false;
    for (size_t offset = 0; offset < length;) {
        size_t sequence = network_utf8_sequence_length(value + offset, length - offset);
        if (sequence == 0) return false;
        offset += sequence;
    }
    return true;
}