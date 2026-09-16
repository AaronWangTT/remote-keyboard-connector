#include "update_policy.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static update_descriptor_t descriptor(void)
{
    return (update_descriptor_t){.magic = {'K', 'B', 'O', 'T', 'A', '0', '0', '1'}, .format_version = 1, .bootstrap_version = 1,
        .updater_version = 1, .settings_version = 1, .kdf_iterations = 10, .flash_bytes = 0x1000000,
        .slot_bytes = UPDATE_SLOT_BYTES, .security_profile = 1, .product = "remote-keyboard", .board = "esp32s3-generic-16m",
        .layout = "kb16-ab6-nvs64-v1", .source = "0123456789abcdef0123456789abcdef01234567", .version = "0.1.0"};
}

int main(void)
{
    uint32_t version[3];
    assert(update_version_parse("0.1.65535", version) && version[2] == 65535);
    const char *invalid[] = {"", "1", "1.2", "1.2.3.4", "1.2.3-beta", "01.2.3", "1..3", "-1.2.3", "65536.0.0",
        "4294967298.0.0", "0.4294967298.0", "0.0.4294967298", "999999999999999.0.0"};
    for (size_t index = 0; index < sizeof(invalid) / sizeof(invalid[0]); index++) assert(!update_version_parse(invalid[index], version));
    update_descriptor_t running = descriptor();
    update_descriptor_t candidate = running;
    assert(update_descriptor_valid(&running));
    assert(!update_descriptor_compatible(&candidate, &running));
    strcpy(candidate.version, "4294967298.0.0");
    assert(!update_descriptor_valid(&candidate) && !update_descriptor_compatible(&candidate, &running));
    strcpy(candidate.version, "0.1.1");
    assert(update_descriptor_compatible(&candidate, &running));
    candidate.kdf_iterations = 100000;
    assert(!update_descriptor_compatible(&candidate, &running));
    candidate.kdf_iterations = 10;
    strcpy(candidate.board, "another-board");
    assert(!update_descriptor_compatible(&candidate, &running));
    candidate = running;
    memset(candidate.version, '1', sizeof(candidate.version));
    assert(!update_descriptor_valid(&candidate));
    candidate = running;
    candidate.padding[39] = 1;
    assert(!update_descriptor_valid(&candidate));

    update_policy_t policy = {0};
    assert(!update_policy_begin(&policy, UPDATE_SLOT_BYTES, 0));
    assert(!update_policy_begin(&policy, 8193, 0));
    assert(update_policy_begin(&policy, 8192, 0));
    assert(!update_policy_begin(&policy, 8192, 0));
    assert(!update_policy_verify(&policy, 1));
    assert(update_policy_write(&policy, 4096, 1));
    assert(!update_policy_write(&policy, 4097, 2));
    assert(update_policy_write(&policy, 4096, 2));
    assert(update_policy_verify(&policy, 3));
    assert(!update_policy_activate(&policy, policy.job_id, 4));
    assert(update_policy_stage(&policy, 4));
    assert(!update_policy_activate(&policy, policy.job_id + 1, 5));
    assert(update_policy_activate(&policy, policy.job_id, 5));
    assert(!update_policy_cancel(&policy, policy.job_id));
    assert(!update_policy_begin(&policy, 8192, 6));

    policy = (update_policy_t){0};
    assert(update_policy_begin(&policy, 8192, 0));
    assert(update_policy_expired(&policy, UPDATE_IDLE_TIMEOUT_US));
    assert(!update_policy_write(&policy, 8192, UPDATE_IDLE_TIMEOUT_US));
    assert(update_policy_cancel(&policy, policy.job_id));
    assert(update_policy_begin(&policy, 8192, 1));
    assert(policy.job_id == 2);
    assert(update_policy_write(&policy, 8192, 2));
    assert(update_policy_verify(&policy, 3));
    assert(update_policy_stage(&policy, 4));
    assert(!update_policy_activate(&policy, 2, 4 + UPDATE_STAGED_TIMEOUT_US));
    puts("update_policy: compatibility, bounds, ordered activation, cancellation and deadlines passed");
}