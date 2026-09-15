#include "network_state.h"
#include "network_text.h"

#include <string.h>
#include "cJSON.h"

static bool ssid_display_control(const uint8_t *value, size_t length)
{
    static const uint32_t ranges[][2] = {
        {0x80, 0x9f}, {0xad, 0xad}, {0x34f, 0x34f}, {0x600, 0x605},
        {0x61c, 0x61c}, {0x6dd, 0x6dd}, {0x70f, 0x70f}, {0x890, 0x891},
        {0x8e2, 0x8e2}, {0x115f, 0x1160}, {0x17b4, 0x17b5}, {0x180b, 0x180f},
        {0x200b, 0x200f}, {0x2028, 0x202e}, {0x2060, 0x206f}, {0x3164, 0x3164},
        {0xfe00, 0xfe0f}, {0xfeff, 0xfeff}, {0xffa0, 0xffa0}, {0xfff0, 0xfffb},
        {0x110bd, 0x110bd}, {0x110cd, 0x110cd}, {0x13430, 0x1343f},
        {0x1bca0, 0x1bca3}, {0x1d173, 0x1d17a}, {0xe0000, 0xe0fff},
    };
    uint32_t point = value[0] & (0x7f >> length);
    for (size_t index = 1; index < length; index++) point = (point << 6) | (value[index] & 0x3f);
    for (size_t index = 0; index < sizeof(ranges) / sizeof(ranges[0]); index++) {
        if (point < ranges[index][0]) return false;
        if (point <= ranges[index][1]) return true;
    }
    return false;
}

void network_ssid_display(const uint8_t *ssid, size_t length, char output[NETWORK_SSID_DISPLAY_MAX + 1])
{
    static const char hex[] = "0123456789ABCDEF";
    if (length > NETWORK_SSID_MAX) length = NETWORK_SSID_MAX;
    size_t written = 0;
    for (size_t index = 0; index < length;) {
        if (ssid[index] >= 0x20 && ssid[index] < 0x7f) {
            output[written++] = (char)ssid[index++];
            continue;
        }
        size_t sequence = network_utf8_sequence_length(ssid + index, length - index);
        if (sequence > 1 && !ssid_display_control(ssid + index, sequence)) {
            memcpy(output + written, ssid + index, sequence);
            written += sequence;
            index += sequence;
            continue;
        }
        output[written++] = '\\';
        output[written++] = 'x';
        output[written++] = hex[ssid[index] >> 4];
        output[written++] = hex[ssid[index] & 0x0f];
        index++;
    }
    output[written] = '\0';
}

void network_ssid_hex(const uint8_t *ssid, size_t length, char output[NETWORK_SSID_MAX * 2 + 1])
{
    static const char hex[] = "0123456789abcdef";
    if (length > NETWORK_SSID_MAX) length = NETWORK_SSID_MAX;
    for (size_t index = 0; index < length; index++) {
        output[index * 2] = hex[ssid[index] >> 4];
        output[index * 2 + 1] = hex[ssid[index] & 0x0f];
    }
    output[length * 2] = '\0';
}

static int hex_digit(char value)
{
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

bool network_hostname_valid(const char *hostname)
{
    if (hostname == NULL) return false;
    size_t length = strlen(hostname);
    if (length == 0 || length > NETWORK_HOSTNAME_MAX || hostname[0] == '-' || hostname[length - 1] == '-') return false;
    for (size_t index = 0; index < length; index++) {
        char character = hostname[index];
        if (!((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-')) return false;
    }
    return strcmp(hostname, "localhost") != 0;
}

static bool profile_valid(const char *ssid, const char *password)
{
    size_t ssid_length = strlen(ssid);
    size_t password_length = strlen(password);
    if (ssid_length == 0 || ssid_length > 32 || password_length < 8 || password_length > 63) return false;
    for (size_t index = 0; index < password_length; index++) {
        if ((unsigned char)password[index] < 32 || (unsigned char)password[index] > 126) return false;
    }
    return true;
}

static bool padded_string_valid(const char *value, size_t capacity)
{
    const char *terminator = memchr(value, 0, capacity);
    if (terminator == NULL) return false;
    for (size_t index = (size_t)(terminator - value) + 1; index < capacity; index++) {
        if (value[index] != '\0') return false;
    }
    return true;
}

bool network_config_valid(const network_config_t *configuration)
{
    if (configuration == NULL || configuration->version != 1 || configuration->station > 1 ||
        !padded_string_valid(configuration->hostname, sizeof(configuration->hostname)) ||
        !padded_string_valid(configuration->ssid, sizeof(configuration->ssid)) ||
        !padded_string_valid(configuration->password, sizeof(configuration->password)) ||
        !network_hostname_valid(configuration->hostname)) return false;
    if (configuration->ssid[0] == '\0') return !configuration->station && configuration->password[0] == '\0';
    return profile_valid(configuration->ssid, configuration->password);
}

bool network_request_parse(const uint8_t *payload, size_t length, network_request_t *request)
{
    if (request == NULL) return false;
    *request = (network_request_t){0};
    if (payload == NULL || length == 0 || length > NETWORK_REQUEST_MAX || memchr(payload, 0, length)) return false;
    if (!network_utf8_valid(payload, length)) return false;
    char buffer[NETWORK_REQUEST_MAX + 1];
    memcpy(buffer, payload, length);
    buffer[length] = '\0';
    for (size_t index = 0; index < length; index++) {
        if (buffer[index] != '\\') continue;
        if (index + 6 <= length && memcmp(buffer + index, "\\u0000", 6) == 0) return false;
        index++;
    }
    cJSON *root = cJSON_ParseWithLengthOpts(buffer, length + 1, NULL, true);
    bool valid = false;
    if (!cJSON_IsObject(root)) goto done;
    const cJSON *action = cJSON_GetObjectItemCaseSensitive(root, "action");
    if (!cJSON_IsString(action)) goto done;
    const char *actions[] = {"", "connect", "ap", "station", "forget", "rename", "cancel", "confirm"};
    for (size_t index = 1; index < sizeof(actions) / sizeof(actions[0]); index++) {
        if (strcmp(action->valuestring, actions[index]) == 0) request->action = (network_action_t)index;
    }
    if (request->action == NETWORK_ACTION_INVALID) goto done;
    unsigned seen = 0;
    const cJSON *field;
    cJSON_ArrayForEach(field, root) {
        unsigned flag = 0;
        bool encoded_ssid = false;
        if (strcmp(field->string, "action") == 0) flag = 1;
        else if (request->action == NETWORK_ACTION_CONNECT && strcmp(field->string, "ssid") == 0) flag = 2;
        else if (request->action == NETWORK_ACTION_CONNECT && strcmp(field->string, "ssid_hex") == 0) {
            flag = 2;
            encoded_ssid = true;
        }
        else if (request->action == NETWORK_ACTION_CONNECT && strcmp(field->string, "password") == 0) flag = 4;
        else if (request->action == NETWORK_ACTION_RENAME && strcmp(field->string, "hostname") == 0) flag = 8;
        if (flag == 0 || (seen & flag) || !cJSON_IsString(field)) goto done;
        seen |= flag;
        size_t count = strlen(field->valuestring);
        if (flag == 2) {
            if (encoded_ssid) {
                if (count == 0 || count > NETWORK_SSID_MAX * 2 || count % 2 != 0) goto done;
                for (size_t index = 0; index < count / 2; index++) {
                    int high = hex_digit(field->valuestring[index * 2]);
                    int low = hex_digit(field->valuestring[index * 2 + 1]);
                    if (high < 0 || low < 0 || (high == 0 && low == 0)) goto done;
                    request->ssid[index] = (char)((high << 4) | low);
                }
                request->ssid[count / 2] = '\0';
            } else {
                if (count == 0 || count > NETWORK_SSID_MAX) goto done;
                memcpy(request->ssid, field->valuestring, count + 1);
            }
        } else if (flag == 4) {
            if (count < 8 || count > 63) goto done;
            memcpy(request->password, field->valuestring, count + 1);
        } else if (flag == 8) {
            if (!network_hostname_valid(field->valuestring)) goto done;
            memcpy(request->hostname, field->valuestring, count + 1);
        }
    }
    unsigned expected = request->action == NETWORK_ACTION_CONNECT ? 7 : request->action == NETWORK_ACTION_RENAME ? 9 : 1;
    valid = seen == expected && (request->action != NETWORK_ACTION_CONNECT || profile_valid(request->ssid, request->password));
done:
    cJSON_Delete(root);
    if (!valid) *request = (network_request_t){0};
    return valid;
}

bool network_config_store(const network_config_t *configuration, uint8_t *active_slot,
                          bool (*stage)(void *, uint8_t, const network_config_t *),
                          bool (*activate)(void *, uint8_t), void *context)
{
    if (!network_config_valid(configuration) || active_slot == NULL || *active_slot > 1 ||
        stage == NULL || activate == NULL) return false;
    uint8_t next = *active_slot == 0 ? 1 : 0;
    if (!stage(context, next, configuration) || !activate(context, next)) return false;
    *active_slot = next;
    return true;
}

void network_state_init(network_state_t *state, bool station, int64_t now)
{
    *state = (network_state_t){ .phase = station ? NETWORK_CONNECTING : NETWORK_AP,
        .ap = !station, .deadline = now + NETWORK_CONNECT_US, .retry_at = now };
}

void network_state_test(network_state_t *state, int64_t now)
{
    *state = (network_state_t){ .phase = NETWORK_TESTING, .ap = true,
        .deadline = now + NETWORK_CONNECT_US, .retry_at = now };
}

void network_state_online(network_state_t *state, int64_t now)
{
    state->online = true;
    state->phase = state->phase == NETWORK_TESTING ? NETWORK_CONFIRMING : NETWORK_STATION;
    state->deadline = now + NETWORK_CONFIRM_US;
    state->handover_at = 0;
}

void network_state_recover(network_state_t *state, int64_t now)
{
    *state = (network_state_t){ .phase = NETWORK_RECOVERY, .ap = true, .retry_at = now + NETWORK_CONNECT_US };
}

void network_state_lost(network_state_t *state, int64_t now)
{
    state->online = false;
    state->handover_at = 0;
    if (state->phase == NETWORK_STATION || state->phase == NETWORK_CONFIRMING) {
        state->phase = state->ap ? NETWORK_RECOVERY : NETWORK_CONNECTING;
        state->deadline = now + NETWORK_CONNECT_US;
        state->retry_at = now + INT64_C(1000000);
        state->attempts = 0;
    }
}

bool network_state_confirm(network_state_t *state, int64_t now)
{
    if (!state->online || !state->ap || (state->phase != NETWORK_CONFIRMING && state->phase != NETWORK_STATION)) return false;
    if (state->handover_at == 0) state->handover_at = now + NETWORK_HANDOVER_US;
    return true;
}

network_effect_t network_state_tick(network_state_t *state, int64_t now, bool held)
{
    if (state->online) {
        if (state->ap && ((state->handover_at != 0 && now >= state->handover_at) ||
            (!held && (state->phase == NETWORK_STATION ||
                       (state->phase == NETWORK_CONFIRMING && now >= state->deadline))))) {
            state->ap = false;
            state->phase = NETWORK_STATION;
            return NETWORK_CLOSE_AP;
        }
        return NETWORK_WAIT;
    }
    if ((state->phase == NETWORK_CONNECTING || state->phase == NETWORK_TESTING) && now >= state->deadline) {
        network_state_recover(state, now);
        return NETWORK_OPEN_AP;
    }
    if (state->phase == NETWORK_AP || (state->phase == NETWORK_RECOVERY && held) || now < state->retry_at) return NETWORK_WAIT;
    if (state->attempts < 5) state->attempts++;
    int64_t delay = state->phase == NETWORK_RECOVERY ? NETWORK_CONNECT_US : (INT64_C(1000000) << (state->attempts - 1));
    if (state->phase != NETWORK_RECOVERY && delay > INT64_C(8000000)) delay = INT64_C(8000000);
    state->retry_at = now + delay;
    return NETWORK_TRY_CONNECT;
}

const char *network_phase_name(network_phase_t phase)
{
    const char *names[] = {"ap", "connecting", "station", "recovery", "testing", "awaiting_confirmation"};
    return phase >= NETWORK_AP && phase <= NETWORK_CONFIRMING ? names[phase] : "unavailable";
}