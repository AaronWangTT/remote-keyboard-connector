#include "board_power_policy.h"

bool board_power_timeout_valid(uint32_t idle_minutes)
{
    return idle_minutes == 0 || idle_minutes == 30 || idle_minutes == 60;
}

bool board_power_policy_configure(board_power_policy_t *policy, uint32_t idle_minutes, int64_t now)
{
    if (!board_power_timeout_valid(idle_minutes) || now < 0) return false;
    *policy = (board_power_policy_t){.idle_minutes = idle_minutes, .last_activity_us = now};
    return true;
}

void board_power_policy_activity(board_power_policy_t *policy, int64_t now)
{
    if (now >= 0) policy->last_activity_us = now;
}

bool board_power_policy_due(board_power_policy_t *policy, int64_t now, bool blocked)
{
    if (now < 0) return false;
    bool was_blocked = policy->blocked;
    policy->blocked = blocked;
    if (blocked || was_blocked || now < policy->last_activity_us) {
        board_power_policy_activity(policy, now);
        return false;
    }
    return policy->idle_minutes != 0 && board_power_timeout_valid(policy->idle_minutes) &&
        now - policy->last_activity_us >= (int64_t)policy->idle_minutes * INT64_C(60000000);
}
