#include "input_protocol.h"

#include <math.h>
#include <string.h>
#include "cJSON.h"

bool input_frame_valid(bool text, bool final, size_t length)
{
    return text && final && length > 0 && length <= INPUT_MESSAGE_MAX_BYTES;
}

static bool integer(const cJSON *value, double maximum)
{
    return cJSON_IsNumber(value) && isfinite(value->valuedouble) &&
           value->valuedouble >= 0 && value->valuedouble <= maximum &&
           floor(value->valuedouble) == value->valuedouble;
}

bool input_message_parse(const uint8_t *payload, size_t length, input_message_t *message)
{
    if (message == NULL) {
        return false;
    }
    *message = (input_message_t){0};
    if (payload == NULL || !input_frame_valid(true, true, length) || memchr(payload, 0, length)) {
        return false;
    }
    char json[INPUT_MESSAGE_MAX_BYTES + 1];
    memcpy(json, payload, length);
    json[length] = 0;
    const char *end;
    cJSON *root = cJSON_ParseWithLengthOpts(json, length + 1, &end, true);
    bool valid = false;
    if (!cJSON_IsObject(root)) {
        goto done;
    }
    const cJSON *version = cJSON_GetObjectItemCaseSensitive(root, "v");
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    if (!integer(version, 1) || version->valueint != 1 || !cJSON_IsString(type)) {
        goto done;
    }
    input_message_t candidate = {0};
    if (strcmp(type->valuestring, "state") == 0) candidate.type = INPUT_STATE;
    else if (strcmp(type->valuestring, "ping") == 0) candidate.type = INPUT_HEARTBEAT;
    else if (strcmp(type->valuestring, "stop") == 0) candidate.type = INPUT_STOP;
    else goto done;

    const char *fields[] = {"v", "type", "seq", "modifiers", "keys"};
    size_t field_count = candidate.type == INPUT_STATE ? 5 : 2;
    unsigned seen = 0;
    const cJSON *field;
    cJSON_ArrayForEach(field, root) {
        size_t index = 0;
        while (index < field_count && strcmp(field->string, fields[index]) != 0) index++;
        if (index == field_count || (seen & (1U << index))) goto done;
        seen |= 1U << index;
    }
    if (seen != (1U << field_count) - 1) goto done;
    if (candidate.type == INPUT_STATE) {
        const cJSON *sequence = cJSON_GetObjectItemCaseSensitive(root, "seq");
        const cJSON *modifiers = cJSON_GetObjectItemCaseSensitive(root, "modifiers");
        const cJSON *keys = cJSON_GetObjectItemCaseSensitive(root, "keys");
        if (!integer(sequence, INT32_MAX) || sequence->valueint == 0 ||
            !integer(modifiers, 255) || !cJSON_IsArray(keys) ||
            cJSON_GetArraySize(keys) > KEYBOARD_KEY_CAPACITY) goto done;
        uint8_t usages[KEYBOARD_KEY_CAPACITY];
        size_t count = 0;
        const cJSON *key;
        cJSON_ArrayForEach(key, keys) {
            if (!integer(key, 255)) goto done;
            usages[count++] = key->valueint;
        }
        if (!keyboard_report_build(&candidate.report, modifiers->valueint, usages, count)) goto done;
        candidate.sequence = sequence->valueint;
    }
    *message = candidate;
    valid = true;
done:
    cJSON_Delete(root);
    return valid;
}