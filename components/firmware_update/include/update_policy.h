#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define UPDATE_SLOT_BYTES UINT32_C(0x600000)
#define UPDATE_IMAGE_LIMIT UINT32_C(0x4cc000)
#define UPDATE_DESCRIPTOR_OFFSET 0x120
#define UPDATE_JOB_TIMEOUT_US INT64_C(300000000)
#define UPDATE_STAGED_TIMEOUT_US INT64_C(120000000)
#define UPDATE_IDLE_TIMEOUT_US INT64_C(10000000)

typedef struct {
    char magic[8];
    uint32_t format_version;
    uint32_t bootstrap_version;
    uint32_t updater_version;
    uint32_t settings_version;
    uint32_t kdf_iterations;
    uint32_t flash_bytes;
    uint32_t slot_bytes;
    uint32_t security_profile;
    char product[32];
    char board[32];
    char layout[32];
    char source[48];
    char version[32];
    uint8_t padding[40];
} update_descriptor_t;

typedef enum {
    UPDATE_IDLE, UPDATE_RECEIVING, UPDATE_VERIFYING, UPDATE_STAGED,
    UPDATE_ACTIVATING, UPDATE_FAILED, UPDATE_CANCELLED
} update_phase_t;

typedef struct {
    update_phase_t phase;
    uint32_t job_id;
    size_t expected;
    size_t received;
    int64_t deadline;
    int64_t last_progress;
} update_policy_t;

bool update_version_parse(const char *text, uint32_t version[3]);
bool update_descriptor_valid(const update_descriptor_t *descriptor);
bool update_descriptor_compatible(const update_descriptor_t *candidate, const update_descriptor_t *running);
bool update_image_size_valid(size_t bytes);
bool update_policy_busy(const update_policy_t *policy);
bool update_policy_begin(update_policy_t *policy, size_t bytes, int64_t now);
bool update_policy_write(update_policy_t *policy, size_t bytes, int64_t now);
bool update_policy_verify(update_policy_t *policy, int64_t now);
bool update_policy_stage(update_policy_t *policy, int64_t now);
bool update_policy_activate(update_policy_t *policy, uint32_t job_id, int64_t now);
bool update_policy_cancel(update_policy_t *policy, uint32_t job_id);
bool update_policy_expired(const update_policy_t *policy, int64_t now);