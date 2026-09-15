#include "board_status_logic.h"

board_status_t board_status_select(const board_status_snapshot_t *snapshot, uint64_t now_ms)
{
    if (!snapshot || !snapshot->valid || !snapshot->ready || now_ms < snapshot->sampled_at_ms ||
        now_ms - snapshot->sampled_at_ms >= BOARD_STATUS_MAX_AGE_MS) return BOARD_STATUS_NOT_READY;
    return snapshot->controller_active ? BOARD_STATUS_CONTROL_ACTIVE : BOARD_STATUS_READY_IDLE;
}

bool board_status_pattern_on(board_status_pattern_t *pattern, board_status_t state, uint64_t now_ms)
{
    if (state != BOARD_STATUS_READY_IDLE && state != BOARD_STATUS_CONTROL_ACTIVE) state = BOARD_STATUS_NOT_READY;
    if (!pattern->initialized || pattern->state != state || now_ms < pattern->cycle_started_ms) {
        pattern->initialized = true;
        pattern->state = state;
        pattern->cycle_started_ms = now_ms;
    }
    uint64_t phase_ms = (now_ms - pattern->cycle_started_ms) % 2000U;
    return state == BOARD_STATUS_CONTROL_ACTIVE || phase_ms < 100U ||
           (state == BOARD_STATUS_NOT_READY && phase_ms >= 200U && phase_ms < 300U);
}

int board_status_active_low_level(bool on)
{
    return on ? 0 : 1;
}