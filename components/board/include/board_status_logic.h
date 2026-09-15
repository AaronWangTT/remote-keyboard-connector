#pragma once

#include <stdbool.h>
#include <stdint.h>

#define BOARD_STATUS_REFRESH_MS 25U
#define BOARD_STATUS_MAX_AGE_MS 75U

typedef enum {
    BOARD_STATUS_NOT_READY,
    BOARD_STATUS_READY_IDLE,
    BOARD_STATUS_CONTROL_ACTIVE,
} board_status_t;

typedef struct {
    bool valid;
    bool ready;
    bool controller_active;
    uint64_t sampled_at_ms;
} board_status_snapshot_t;

typedef struct {
    bool initialized;
    board_status_t state;
    uint64_t cycle_started_ms;
} board_status_pattern_t;

board_status_t board_status_select(const board_status_snapshot_t *snapshot, uint64_t now_ms);
bool board_status_pattern_on(board_status_pattern_t *pattern, board_status_t state, uint64_t now_ms);
int board_status_active_low_level(bool on);