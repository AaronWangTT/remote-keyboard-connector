#include "keyboard_state.h"

#include <string.h>
#include "class/hid/hid.h"

static bool supported_usage(uint8_t usage)
{
    return (usage >= HID_KEY_A && usage <= HID_KEY_ENTER) || usage == HID_KEY_BACKSPACE ||
           (usage >= HID_KEY_SPACE && usage <= HID_KEY_CAPS_LOCK && usage != HID_KEY_EUROPE_1);
}

bool keyboard_report_empty(const keyboard_report_t *report)
{
    const keyboard_report_t neutral = {0};
    return memcmp(report, &neutral, sizeof(neutral)) == 0;
}

bool keyboard_report_valid(const keyboard_report_t *report)
{
    if (report == NULL || report->reserved != 0 ||
        (report->modifiers & ~(KEYBOARD_MODIFIER_LEFTSHIFT | KEYBOARD_MODIFIER_RIGHTSHIFT))) {
        return false;
    }
    uint8_t previous = 0;
    bool ended = false;
    for (size_t index = 0; index < KEYBOARD_KEY_CAPACITY; index++) {
        uint8_t usage = report->keys[index];
        if (usage == 0) {
            ended = true;
        } else {
            if (ended || !supported_usage(usage) || usage <= previous) {
                return false;
            }
            previous = usage;
        }
    }
    return true;
}

bool keyboard_report_build(keyboard_report_t *report, uint8_t modifiers,
                            const uint8_t *keys, size_t count)
{
    if (report == NULL) {
        return false;
    }
    *report = (keyboard_report_t){0};
    if (count > KEYBOARD_KEY_CAPACITY || (count && keys == NULL)) {
        return false;
    }
    keyboard_report_t candidate = {.modifiers = modifiers};
    for (size_t index = 0; index < count; index++) {
        if (!supported_usage(keys[index])) {
            return false;
        }
        size_t position = index;
        while (position > 0 && candidate.keys[position - 1] > keys[index]) {
            candidate.keys[position] = candidate.keys[position - 1];
            position--;
        }
        candidate.keys[position] = keys[index];
    }
    if (!keyboard_report_valid(&candidate)) {
        return false;
    }
    *report = candidate;
    return true;
}

void keyboard_state_init(keyboard_state_t *state)
{
    memset(state, 0, sizeof(*state));
    state->generation = 1;
    state->neutral_pending = true;
}

void keyboard_state_release(keyboard_state_t *state)
{
    state->head = 0;
    state->count = 0;
    state->desired_report = (keyboard_report_t){0};
    state->neutral_pending = true;
    state->flight_neutral = false;
    state->generation++;
}

void keyboard_state_usb(keyboard_state_t *state, bool online)
{
    keyboard_state_release(state);
    state->online = online;
    state->in_flight = false;
}

bool keyboard_state_ready(const keyboard_state_t *state)
{
    return state->online && !state->neutral_pending;
}

bool keyboard_state_heartbeat(keyboard_state_t *state, uint32_t generation,
                              int64_t now)
{
    keyboard_state_tick(state, now);
    if (!keyboard_state_ready(state) || generation != state->generation) {
        return false;
    }
    state->last_activity = now;
    return true;
}

bool keyboard_state_input(keyboard_state_t *state, uint32_t generation,
                          const keyboard_report_t *report, int64_t now)
{
    if (generation != state->generation) {
        return false;
    }
    if (!keyboard_report_valid(report)) {
        keyboard_state_release(state);
        return false;
    }
    if (!keyboard_state_heartbeat(state, generation, now)) {
        return false;
    }
    if (memcmp(report, &state->desired_report, sizeof(*report)) == 0) {
        return true;
    }
    if (state->count == KEYBOARD_QUEUE_CAPACITY) {
        keyboard_state_release(state);
        return false;
    }
    size_t tail = (state->head + state->count) % KEYBOARD_QUEUE_CAPACITY;
    state->queue[tail] = (keyboard_transition_t) {
        .report = *report,
        .queued_at = now,
    };
    state->count++;
    state->desired_report = *report;
    return true;
}

void keyboard_state_tick(keyboard_state_t *state, int64_t now)
{
    if (!keyboard_state_ready(state)) {
        return;
    }
    bool idle = (!keyboard_report_empty(&state->desired_report) || state->count || state->in_flight) &&
                now - state->last_activity >= KEYBOARD_IDLE_TIMEOUT_US;
    bool overdue = state->count &&
                   now - state->queue[state->head].queued_at >= KEYBOARD_REPORT_TIMEOUT_US;
    bool stalled = state->in_flight &&
                   now - state->submitted_at >= KEYBOARD_REPORT_TIMEOUT_US;
    if (idle || overdue || stalled) {
        keyboard_state_release(state);
    }
}

bool keyboard_state_next(keyboard_state_t *state, int64_t now, keyboard_report_t *report)
{
    keyboard_state_tick(state, now);
    if (!state->online || state->in_flight ||
        (!state->neutral_pending && !state->count)) {
        return false;
    }
    state->flight_neutral = state->neutral_pending;
    state->flight_report = (keyboard_report_t){0};
    if (!state->neutral_pending) {
        state->flight_report = state->queue[state->head].report;
        state->head = (state->head + 1) % KEYBOARD_QUEUE_CAPACITY;
        state->count--;
    }
    state->in_flight = true;
    state->submitted_at = now;
    *report = state->flight_report;
    return true;
}

void keyboard_state_complete(keyboard_state_t *state)
{
    if (!state->in_flight) {
        return;
    }
    if (state->flight_neutral) {
        state->neutral_pending = false;
    }
    state->in_flight = false;
}

void keyboard_state_submit_failed(keyboard_state_t *state)
{
    state->in_flight = false;
    keyboard_state_release(state);
}