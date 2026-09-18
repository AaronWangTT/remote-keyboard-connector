#include <assert.h>
#include <stdio.h>

#include "board_power_policy.h"

int main(void)
{
    const int64_t minute = INT64_C(60000000);
    board_power_policy_t policy = {0};
    assert(board_power_policy_configure(&policy, BOARD_POWER_DEFAULT_IDLE_MINUTES, 0));
    assert(!board_power_policy_due(&policy, 30 * minute - 1, false));
    assert(board_power_policy_due(&policy, 30 * minute, false));
    board_power_policy_activity(&policy, 30 * minute);
    assert(!board_power_policy_due(&policy, 60 * minute - 1, false));
    assert(board_power_policy_due(&policy, 60 * minute, false));

    assert(board_power_policy_configure(&policy, 60, minute));
    assert(!board_power_policy_due(&policy, 61 * minute - 1, false));
    assert(board_power_policy_due(&policy, 61 * minute, false));
    assert(board_power_policy_configure(&policy, 0, 0));
    assert(!board_power_policy_due(&policy, INT64_MAX, false));
    assert(!board_power_policy_configure(&policy, 1, 0));
    assert(!board_power_policy_configure(&policy, UINT32_MAX, 0));
    assert(!board_power_policy_configure(&policy, 30, -1));
    assert(policy.idle_minutes == 0);

    assert(board_power_policy_configure(&policy, 30, 0));
    assert(!board_power_policy_due(&policy, 60 * minute, true));
    assert(!board_power_policy_due(&policy, 90 * minute, true));
    assert(!board_power_policy_due(&policy, 100 * minute, false));
    assert(!board_power_policy_due(&policy, 130 * minute - 1, false));
    assert(board_power_policy_due(&policy, 130 * minute, false));

    assert(board_power_policy_configure(&policy, 30, 60 * minute));
    assert(!board_power_policy_due(&policy, -1, false));
    assert(!board_power_policy_due(&policy, 0, false));
    assert(!board_power_policy_due(&policy, 30 * minute - 1, false));
    assert(board_power_policy_due(&policy, 30 * minute, false));
    board_power_policy_activity(&policy, -1);
    assert(policy.last_activity_us == 0);
    puts("PASS: board power deadlines, settings, blockers, and monotonic timing");
    return 0;
}
