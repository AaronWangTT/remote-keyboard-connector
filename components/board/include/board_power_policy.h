#pragma once

#include <stdbool.h>
#include <stdint.h>

#define BOARD_POWER_DEFAULT_IDLE_MINUTES 30

typedef struct {
    uint32_t idle_minutes;
    int64_t last_activity_us;
    bool blocked;
} board_power_policy_t;

bool board_power_timeout_valid(uint32_t idle_minutes);
bool board_power_policy_configure(board_power_policy_t *policy, uint32_t idle_minutes, int64_t now);
void board_power_policy_activity(board_power_policy_t *policy, int64_t now);
bool board_power_policy_due(board_power_policy_t *policy, int64_t now, bool blocked);
