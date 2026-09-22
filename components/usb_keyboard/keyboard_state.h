#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "keyboard_report.h"

#define KEYBOARD_QUEUE_CAPACITY 32
#define KEYBOARD_IDLE_TIMEOUT_US INT64_C(1000000)
#define KEYBOARD_REPORT_TIMEOUT_US INT64_C(250000)

typedef struct {
    keyboard_report_t report;
    int64_t queued_at;
} keyboard_transition_t;

typedef struct {
    keyboard_transition_t queue[KEYBOARD_QUEUE_CAPACITY];
    size_t head;
    size_t count;
    uint32_t generation;
    bool online;
    bool neutral_pending;
    bool in_flight;
    keyboard_report_t flight_report;
    bool flight_neutral;
    keyboard_report_t desired_report;
    int64_t last_activity;
    int64_t submitted_at;
} keyboard_state_t;

void keyboard_state_init(keyboard_state_t *state);
void keyboard_state_usb(keyboard_state_t *state, bool online);
void keyboard_state_release(keyboard_state_t *state);
bool keyboard_state_ready(const keyboard_state_t *state);
bool keyboard_state_input(keyboard_state_t *state, uint32_t generation,
                          const keyboard_report_t *report, int64_t now);
bool keyboard_state_wakeup(keyboard_state_t *state, uint32_t generation, int64_t now);
bool keyboard_state_heartbeat(keyboard_state_t *state, uint32_t generation,
                              int64_t now);
void keyboard_state_tick(keyboard_state_t *state, int64_t now);
bool keyboard_state_next(keyboard_state_t *state, int64_t now, keyboard_report_t *report);
void keyboard_state_complete(keyboard_state_t *state);
void keyboard_state_submit_failed(keyboard_state_t *state);