#include "board_status_logic.h"

#include <assert.h>
#include <stdio.h>

static void test_selection(void)
{
    board_status_snapshot_t snapshot = {0};
    assert(board_status_select(NULL, 0) == BOARD_STATUS_NOT_READY);
    assert(board_status_select(&snapshot, 0) == BOARD_STATUS_NOT_READY);
    snapshot.valid = true;
    snapshot.controller_active = true;
    assert(board_status_select(&snapshot, 0) == BOARD_STATUS_NOT_READY);
    snapshot.ready = true;
    assert(board_status_select(&snapshot, 0) == BOARD_STATUS_CONTROL_ACTIVE);
    snapshot.controller_active = false;
    assert(board_status_select(&snapshot, 0) == BOARD_STATUS_READY_IDLE);
    snapshot.sampled_at_ms = 1000;
    assert(board_status_select(&snapshot, 999) == BOARD_STATUS_NOT_READY);
    assert(board_status_select(&snapshot, 1074) == BOARD_STATUS_READY_IDLE);
    assert(board_status_select(&snapshot, 1075) == BOARD_STATUS_NOT_READY);
    snapshot.controller_active = true;
    assert(board_status_select(&snapshot, 1074) == BOARD_STATUS_CONTROL_ACTIVE);
    assert(board_status_select(&snapshot, 1075) == BOARD_STATUS_NOT_READY);
    snapshot.valid = false;
    assert(board_status_select(&snapshot, 1000) == BOARD_STATUS_NOT_READY);
    snapshot.valid = true;
    snapshot.ready = false;
    assert(board_status_select(&snapshot, 1000) == BOARD_STATUS_NOT_READY);
}

static void test_patterns(void)
{
    const uint64_t phases[] = {0, 99, 100, 199, 200, 299, 300, 1999, 2000, 2099, 2100, 2200, 2300};
    const bool idle[] = {true, true, false, false, false, false, false, false, true, true, false, false, false};
    const bool blocked[] = {true, true, false, false, true, true, false, false, true, true, false, true, false};
    for (board_status_t state = BOARD_STATUS_NOT_READY; state <= BOARD_STATUS_CONTROL_ACTIVE; state++) {
        board_status_pattern_t pattern = {0};
        for (size_t index = 0; index < sizeof(phases) / sizeof(phases[0]); index++) {
            bool expected = state == BOARD_STATUS_CONTROL_ACTIVE ||
                            (state == BOARD_STATUS_READY_IDLE ? idle[index] : blocked[index]);
            assert(board_status_pattern_on(&pattern, state, 1000 + phases[index]) == expected);
            assert(pattern.cycle_started_ms == 1000);
        }
    }
    board_status_pattern_t pattern = {0};
    assert(board_status_pattern_on(&pattern, BOARD_STATUS_READY_IDLE, 1000));
    assert(!board_status_pattern_on(&pattern, BOARD_STATUS_READY_IDLE, 1900));
    assert(board_status_pattern_on(&pattern, BOARD_STATUS_NOT_READY, 1900));
    assert(!board_status_pattern_on(&pattern, BOARD_STATUS_NOT_READY, 2000));
    assert(board_status_pattern_on(&pattern, BOARD_STATUS_NOT_READY, 2100));
    assert(!board_status_pattern_on(&pattern, BOARD_STATUS_NOT_READY, 2200));
    assert(board_status_pattern_on(&pattern, BOARD_STATUS_NOT_READY, 1003900));
    assert(!board_status_pattern_on(&pattern, BOARD_STATUS_NOT_READY, 1004200));
    assert(pattern.cycle_started_ms == 1900);
    assert(board_status_pattern_on(&pattern, BOARD_STATUS_CONTROL_ACTIVE, 1004200));
    assert(board_status_pattern_on(&pattern, BOARD_STATUS_CONTROL_ACTIVE, UINT64_MAX));
    assert(board_status_pattern_on(&pattern, BOARD_STATUS_READY_IDLE, 1004300));
    assert(!board_status_pattern_on(&pattern, BOARD_STATUS_READY_IDLE, 1004400));
    assert(board_status_pattern_on(&pattern, BOARD_STATUS_READY_IDLE, 0));
    assert(board_status_pattern_on(&pattern, (board_status_t)99, 1));
    assert(pattern.state == BOARD_STATUS_NOT_READY);
    assert(board_status_active_low_level(true) == 0);
    assert(board_status_active_low_level(false) == 1);
}

int main(void)
{
    test_selection();
    test_patterns();
    puts("PASS: board status selection, freshness, pulse boundaries, phase continuity, delays and polarity");
    return 0;
}