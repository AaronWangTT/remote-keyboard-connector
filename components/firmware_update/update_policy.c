#include "update_policy.h"

#include <string.h>

_Static_assert(sizeof(update_descriptor_t) == 256, "Update descriptor must occupy 256 bytes");

bool update_version_parse(const char *text, uint32_t version[3])
{
    if (text == NULL || version == NULL) return false;
    for (size_t part = 0; part < 3; part++) {
        uint32_t value = 0;
        const char *start = text;
        while (*text >= '0' && *text <= '9') {
            uint32_t digit = (uint32_t)(*text++ - '0');
            if (value > (UINT32_C(65535) - digit) / 10) return false;
            value = value * 10 + digit;
        }
        if (text == start || (text - start > 1 && *start == '0')) return false;
        version[part] = value;
        if (part < 2 && *text++ != '.') return false;
    }
    return *text == '\0';
}

static bool text_valid(const char *text, size_t capacity)
{
    const char *end = memchr(text, '\0', capacity);
    if (end == NULL || end == text) return false;
    for (const char *character = text; character < end; character++) {
        if (*character < 0x21 || *character > 0x7e) return false;
    }
    return true;
}

bool update_descriptor_valid(const update_descriptor_t *descriptor)
{
    uint32_t version[3];
    if (descriptor == NULL || memcmp(descriptor->magic, "KBOTA001", 8) != 0 ||
        descriptor->format_version != 1 || (descriptor->security_profile != 1 && descriptor->security_profile != 2) ||
        descriptor->bootstrap_version != 1 || descriptor->updater_version != 1 ||
        descriptor->settings_version != 1 || descriptor->kdf_iterations != 10 ||
        descriptor->flash_bytes != 0x1000000 || descriptor->slot_bytes != UPDATE_SLOT_BYTES ||
        !text_valid(descriptor->product, sizeof(descriptor->product)) ||
        !text_valid(descriptor->board, sizeof(descriptor->board)) ||
        !text_valid(descriptor->layout, sizeof(descriptor->layout)) ||
        !text_valid(descriptor->source, sizeof(descriptor->source)) ||
        !text_valid(descriptor->version, sizeof(descriptor->version)) ||
        !update_version_parse(descriptor->version, version)) return false;
    if (strlen(descriptor->source) != 40) return false;
    for (size_t index = 0; index < 40; index++) {
        char character = descriptor->source[index];
        if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
    }
    for (size_t index = 0; index < sizeof(descriptor->padding); index++) {
        if (descriptor->padding[index] != 0) return false;
    }
    return true;
}

bool update_descriptor_compatible(const update_descriptor_t *candidate, const update_descriptor_t *running)
{
    if (!update_descriptor_valid(candidate) || !update_descriptor_valid(running) ||
        strcmp(candidate->product, running->product) != 0 || strcmp(candidate->board, running->board) != 0 ||
        strcmp(candidate->layout, running->layout) != 0 || candidate->security_profile != running->security_profile) return false;
    uint32_t next[3], current[3];
    if (!update_version_parse(candidate->version, next) || !update_version_parse(running->version, current)) return false;
    for (size_t part = 0; part < 3; part++) {
        if (next[part] != current[part]) return next[part] > current[part];
    }
    return false;
}

bool update_image_size_valid(size_t bytes)
{
    return bytes >= 8192 && bytes <= UPDATE_IMAGE_LIMIT && bytes % 4096 == 0;
}

bool update_policy_busy(const update_policy_t *policy)
{
    return policy->phase >= UPDATE_RECEIVING && policy->phase <= UPDATE_ACTIVATING;
}

bool update_policy_begin(update_policy_t *policy, size_t bytes, int64_t now)
{
    if (update_policy_busy(policy) || !update_image_size_valid(bytes)) return false;
    uint32_t next = policy->job_id + 1;
    *policy = (update_policy_t){.phase = UPDATE_RECEIVING, .job_id = next != 0 ? next : 1,
        .expected = bytes, .deadline = now + UPDATE_JOB_TIMEOUT_US, .last_progress = now};
    return true;
}

bool update_policy_expired(const update_policy_t *policy, int64_t now)
{
    return (policy->phase >= UPDATE_RECEIVING && policy->phase <= UPDATE_STAGED) &&
        (now >= policy->deadline || (policy->phase == UPDATE_RECEIVING && now - policy->last_progress >= UPDATE_IDLE_TIMEOUT_US));
}

bool update_policy_write(update_policy_t *policy, size_t bytes, int64_t now)
{
    if (policy->phase != UPDATE_RECEIVING || update_policy_expired(policy, now) ||
        bytes == 0 || bytes > policy->expected - policy->received) return false;
    policy->received += bytes;
    policy->last_progress = now;
    return true;
}

bool update_policy_verify(update_policy_t *policy, int64_t now)
{
    if (policy->phase != UPDATE_RECEIVING || policy->received != policy->expected || update_policy_expired(policy, now)) return false;
    policy->phase = UPDATE_VERIFYING;
    return true;
}

bool update_policy_stage(update_policy_t *policy, int64_t now)
{
    if (policy->phase != UPDATE_VERIFYING || update_policy_expired(policy, now)) return false;
    policy->phase = UPDATE_STAGED;
    policy->deadline = now + UPDATE_STAGED_TIMEOUT_US;
    return true;
}

bool update_policy_activate(update_policy_t *policy, uint32_t job_id, int64_t now)
{
    if (policy->phase != UPDATE_STAGED || policy->job_id != job_id || update_policy_expired(policy, now)) return false;
    policy->phase = UPDATE_ACTIVATING;
    return true;
}

bool update_policy_cancel(update_policy_t *policy, uint32_t job_id)
{
    if (!update_policy_busy(policy) || policy->phase == UPDATE_ACTIVATING || policy->job_id != job_id) return false;
    policy->phase = UPDATE_CANCELLED;
    return true;
}