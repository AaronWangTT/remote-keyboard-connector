#include "keyboard_state.h"
#include "usb_descriptors.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static bool input_a(keyboard_state_t *state, uint32_t generation, bool pressed, int64_t now)
{
    const keyboard_report_t report = {.keys = {pressed ? HID_KEY_A : 0}};
    return keyboard_state_input(state, generation, &report, now);
}

static bool next_a(keyboard_state_t *state, int64_t now, bool *pressed)
{
    keyboard_report_t report;
    bool available = keyboard_state_next(state, now, &report);
    if (available) {
        *pressed = !keyboard_report_empty(&report);
    }
    return available;
}

static void test_typing_reports(void)
{
    keyboard_report_t report;
    const uint8_t keys[] = {HID_KEY_Z, HID_KEY_A, HID_KEY_ENTER, HID_KEY_BACKSPACE, HID_KEY_SPACE, HID_KEY_SLASH};
    assert(keyboard_report_build(&report, KEYBOARD_MODIFIER_LEFTSHIFT, keys, 6));
    const uint8_t expected[8] = {2, 0, HID_KEY_A, HID_KEY_Z, HID_KEY_ENTER, HID_KEY_BACKSPACE, HID_KEY_SPACE, HID_KEY_SLASH};
    assert(memcmp(&report, expected, sizeof(expected)) == 0);
    assert(!keyboard_report_build(&report, 0, keys, 7));
    assert(keyboard_report_empty(&report));
    for (int modifier = 0; modifier <= 255; modifier++) {
        assert(keyboard_report_build(&report, modifier, keys, 1) == ((modifier & ~0x22) == 0));
    }
    for (int usage = 0; usage <= 255; usage++) {
        const uint8_t candidate = usage;
        bool supported = (usage >= 4 && usage <= 42) ||
                         (usage >= 44 && usage <= 57 && usage != 50);
        assert(keyboard_report_build(&report, 0, &candidate, 1) == supported);
    }

    const uint8_t space[] = {HID_KEY_SPACE};
    assert(keyboard_report_build(&report, KEYBOARD_MODIFIER_LEFTCTRL, space, 1));
    const uint8_t ios_globe[8] = {0x01, 0, HID_KEY_SPACE, 0, 0, 0, 0, 0};
    assert(memcmp(&report, ios_globe, sizeof(ios_globe)) == 0);
    assert(keyboard_report_build(&report, KEYBOARD_MODIFIER_LEFTGUI, space, 1));
    const uint8_t windows_globe[8] = {0x08, 0, HID_KEY_SPACE, 0, 0, 0, 0, 0};
    assert(memcmp(&report, windows_globe, sizeof(windows_globe)) == 0);

    const uint8_t escape[] = {HID_KEY_ESCAPE};
    assert(keyboard_report_build(&report, 0, escape, 1));
    const uint8_t cancel[8] = {0, 0, HID_KEY_ESCAPE, 0, 0, 0, 0, 0};
    assert(memcmp(&report, cancel, sizeof(cancel)) == 0);
    assert(keyboard_report_build(&report, 0, NULL, 0));
    assert(keyboard_report_empty(&report));
    assert(!keyboard_report_build(&report, KEYBOARD_MODIFIER_LEFTCTRL, keys, 1));
    assert(!keyboard_report_build(&report, KEYBOARD_MODIFIER_LEFTCTRL | KEYBOARD_MODIFIER_LEFTSHIFT, space, 1));
    assert(!keyboard_report_build(&report, KEYBOARD_MODIFIER_LEFTCTRL | KEYBOARD_MODIFIER_LEFTGUI, space, 1));
    const uint8_t escape_chord[] = {HID_KEY_ESCAPE, HID_KEY_A};
    assert(!keyboard_report_build(&report, 0, escape_chord, 2));
    assert(!keyboard_report_build(&report, KEYBOARD_MODIFIER_LEFTSHIFT, escape, 1));

    const uint8_t duplicate[] = {HID_KEY_A, HID_KEY_A};
    assert(!keyboard_report_build(&report, 0, duplicate, 2));
    assert(!keyboard_report_build(&report, 0, NULL, 1));
    assert(keyboard_report_build(&report, KEYBOARD_MODIFIER_RIGHTSHIFT, NULL, 0));
    assert(!keyboard_report_empty(&report));
    report.reserved = 1;
    assert(!keyboard_report_valid(&report));
}

static void test_descriptors_and_reports(void)
{
    hid_keyboard_report_t report = keyboard_report(true);
    const uint8_t expected[8] = {0, 0, HID_KEY_A, 0, 0, 0, 0, 0};
    assert(memcmp(&report, expected, sizeof(expected)) == 0);
    report = keyboard_report(false);
    const uint8_t neutral[8] = {0};
    assert(memcmp(&report, neutral, sizeof(neutral)) == 0);
    assert(sizeof(keyboard_configuration_descriptor) == TUD_CONFIG_DESC_LEN + TUD_HID_DESC_LEN);
    assert(keyboard_configuration_descriptor[4] == 1);
    assert(keyboard_configuration_descriptor[7] == 0x80);
    assert(keyboard_configuration_descriptor[TUD_CONFIG_DESC_LEN + 5] == TUSB_CLASS_HID);
    assert(keyboard_configuration_descriptor[TUD_CONFIG_DESC_LEN + 6] == HID_SUBCLASS_BOOT);
    assert(keyboard_configuration_descriptor[TUD_CONFIG_DESC_LEN + 7] == HID_ITF_PROTOCOL_KEYBOARD);
}

static keyboard_state_t ready_keyboard(void)
{
    keyboard_state_t state;
    bool pressed = true;
    keyboard_state_init(&state);
    assert(!keyboard_state_ready(&state));
    assert(!next_a(&state, 0, &pressed));
    keyboard_state_usb(&state, true);
    assert(!input_a(&state, state.generation, true, 0));
    assert(next_a(&state, 0, &pressed));
    assert(!pressed);
    assert(!keyboard_state_ready(&state));
    keyboard_state_complete(&state);
    assert(keyboard_state_ready(&state));
    return state;
}

static void test_ordering(void)
{
    keyboard_state_t state = ready_keyboard();
    keyboard_report_t report;
    for (int tap = 0; tap < 1000; tap++) {
        int64_t now = (int64_t)tap * 20000;
        const keyboard_report_t chord = {.modifiers = KEYBOARD_MODIFIER_LEFTSHIFT,
            .keys = {HID_KEY_A, HID_KEY_Z}};
        const keyboard_report_t released = {0};
        assert(keyboard_state_input(&state, state.generation, &chord, now));
        assert(keyboard_state_input(&state, state.generation, &chord, now));
        assert(keyboard_state_input(&state, state.generation, &released, now));
        assert(state.count == 2);
        assert(keyboard_state_next(&state, now, &report));
        assert(memcmp(&report, &chord, sizeof(report)) == 0);
        assert(!keyboard_state_next(&state, now, &report));
        keyboard_state_complete(&state);
        assert(keyboard_state_next(&state, now + 10000, &report) && keyboard_report_empty(&report));
        keyboard_state_complete(&state);
        assert(!keyboard_state_next(&state, now + 10000, &report));
    }
}

static void test_priority_release(void)
{
    keyboard_state_t state = ready_keyboard();
    uint32_t old_generation = state.generation;
    bool pressed;
    assert(input_a(&state, old_generation, true, 0));
    assert(next_a(&state, 0, &pressed) && pressed);
    assert(input_a(&state, old_generation, false, 1));
    assert(input_a(&state, old_generation, true, 2));
    keyboard_state_release(&state);
    assert(state.count == 0);
    assert(!input_a(&state, old_generation, true, 3));
    assert(!keyboard_state_heartbeat(&state, old_generation, 3));
    assert(!next_a(&state, 3, &pressed));
    keyboard_state_complete(&state);
    assert(!keyboard_state_ready(&state));
    assert(next_a(&state, 4, &pressed) && !pressed);
    keyboard_state_release(&state);
    keyboard_state_complete(&state);
    assert(!keyboard_state_ready(&state));
    assert(next_a(&state, 5, &pressed) && !pressed);
    keyboard_state_complete(&state);
    assert(keyboard_state_ready(&state));
    assert(!input_a(&state, old_generation, true, 6));
}

static void test_overflow(void)
{
    keyboard_state_t state = ready_keyboard();
    uint32_t generation = state.generation;
    bool pressed;
    for (size_t index = 0; index < KEYBOARD_QUEUE_CAPACITY; index++) {
        assert(input_a(&state, generation, index % 2 == 0, 0));
    }
    assert(!input_a(&state, generation, true, 0));
    assert(state.count == 0);
    assert(next_a(&state, 0, &pressed) && !pressed);
    keyboard_state_complete(&state);
    assert(!next_a(&state, 0, &pressed));
}

static void test_deadlines(void)
{
    keyboard_state_t state = ready_keyboard();
    bool pressed;
    assert(input_a(&state, state.generation, true, 0));
    assert(next_a(&state, 0, &pressed) && pressed);
    keyboard_state_complete(&state);
    keyboard_state_tick(&state, KEYBOARD_IDLE_TIMEOUT_US - 1);
    assert(keyboard_state_ready(&state));
    assert(keyboard_state_heartbeat(&state, state.generation, 500000));
    keyboard_state_tick(&state, 1499999);
    assert(keyboard_state_ready(&state));
    keyboard_state_tick(&state, 1500000);
    assert(next_a(&state, 1500000, &pressed) && !pressed);

    state = ready_keyboard();
    uint32_t generation = state.generation;
    assert(input_a(&state, generation, true, 0));
    assert(next_a(&state, 0, &pressed));
    keyboard_state_complete(&state);
    assert(!keyboard_state_heartbeat(&state, generation, KEYBOARD_IDLE_TIMEOUT_US));
    assert(!keyboard_state_ready(&state));

    state = ready_keyboard();
    assert(input_a(&state, state.generation, true, 0));
    assert(next_a(&state, KEYBOARD_REPORT_TIMEOUT_US, &pressed));
    assert(!pressed);
    keyboard_state_complete(&state);
    assert(!next_a(&state, KEYBOARD_REPORT_TIMEOUT_US, &pressed));

    state = ready_keyboard();
    assert(input_a(&state, state.generation, true, 0));
    assert(next_a(&state, 0, &pressed));
    keyboard_state_tick(&state, KEYBOARD_REPORT_TIMEOUT_US);
    assert(!keyboard_state_ready(&state));
    assert(!next_a(&state, KEYBOARD_REPORT_TIMEOUT_US, &pressed));
    keyboard_state_complete(&state);
    assert(next_a(&state, KEYBOARD_REPORT_TIMEOUT_US, &pressed));
    assert(!pressed);
}

static void test_usb_recovery(void)
{
    keyboard_state_t state = ready_keyboard();
    uint32_t generation = state.generation;
    bool pressed;
    assert(input_a(&state, generation, true, 0));
    assert(next_a(&state, 0, &pressed));
    keyboard_state_usb(&state, false);
    keyboard_state_complete(&state);
    assert(!next_a(&state, 1, &pressed));
    assert(!input_a(&state, generation, true, 1));
    keyboard_state_usb(&state, true);
    assert(next_a(&state, 2, &pressed) && !pressed);
    keyboard_state_complete(&state);
    assert(!next_a(&state, 3, &pressed));
    assert(!input_a(&state, generation, true, 3));
    assert(input_a(&state, state.generation, true, 3));
    assert(next_a(&state, 3, &pressed));
    keyboard_state_submit_failed(&state);
    assert(next_a(&state, 4, &pressed) && !pressed);
}

static void test_invalid_state_release(void)
{
    keyboard_state_t state = ready_keyboard();
    uint32_t generation = state.generation;
    assert(input_a(&state, generation, true, 0));
    const keyboard_report_t invalid = {.keys = {HID_KEY_A, HID_KEY_A}};
    assert(!keyboard_state_input(&state, generation - 1, &invalid, 1));
    assert(state.generation == generation);
    assert(!keyboard_state_input(&state, generation, &invalid, 2));
    assert(state.count == 0 && state.neutral_pending);
    keyboard_report_t report;
    assert(keyboard_state_next(&state, 2, &report) && keyboard_report_empty(&report));
}

int main(void)
{
    test_descriptors_and_reports();
    test_typing_reports();
    test_ordering();
    test_priority_release();
    test_overflow();
    test_deadlines();
    test_usb_recovery();
    test_invalid_state_release();
    puts("keyboard_state: 8 tests passed (typing allowlist, six-key reports, 1000 ordered Shift chords)");
    return 0;
}