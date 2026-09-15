#include "access_control.h"
#include "network_text.h"

#include <string.h>
#include "cJSON.h"

static bool normalize_host(const char *host, char normalized[80], bool secure)
{
    if (host == NULL || strlen(host) == 0 || strlen(host) >= 80) {
        return false;
    }
    const char *port = strchr(host, ':');
    if (port != NULL && strcmp(port, secure ? ":443" : ":80") != 0) {
        return false;
    }
    size_t length = port == NULL ? strlen(host) : (size_t)(port - host);
    if (length == 0) {
        return false;
    }
    for (size_t index = 0; index < length; index++) {
        char character = host[index];
        if (character >= 'A' && character <= 'Z') {
            character += 'a' - 'A';
        }
        if (!((character >= 'a' && character <= 'z') ||
              (character >= '0' && character <= '9') || character == '-' || character == '.')) {
            return false;
        }
        normalized[index] = character;
    }
    normalized[length] = '\0';
    return true;
}

bool access_host_allowed(const char *host, const char *const *allowed, size_t count, bool secure)
{
    char normalized[80];
    if (allowed == NULL || !normalize_host(host, normalized, secure)) {
        return false;
    }
    for (size_t index = 0; index < count; index++) {
        if (allowed[index] != NULL && strcmp(normalized, allowed[index]) == 0) {
            return true;
        }
    }
    return false;
}

bool access_origin_allowed(const char *host, const char *origin,
                           const char *const *allowed, size_t count, bool secure)
{
    const char *scheme = secure ? "https://" : "http://";
    char normalized_host[80];
    char normalized_origin[80];
    return origin != NULL && strncmp(origin, scheme, strlen(scheme)) == 0 &&
           access_host_allowed(host, allowed, count, secure) &&
           normalize_host(host, normalized_host, secure) &&
           normalize_host(origin + strlen(scheme), normalized_origin, secure) &&
           strcmp(normalized_host, normalized_origin) == 0;
}

static bool token_valid(const char *token)
{
    if (token == NULL || strlen(token) != ACCESS_TOKEN_LENGTH) {
        return false;
    }
    for (size_t index = 0; index < ACCESS_TOKEN_LENGTH; index++) {
        if (!((token[index] >= '0' && token[index] <= '9') ||
              (token[index] >= 'a' && token[index] <= 'f'))) {
            return false;
        }
    }
    return true;
}

bool access_token_equal(const char *left, const char *right)
{
    if (!token_valid(left) || !token_valid(right)) {
        return false;
    }
    unsigned difference = 0;
    for (size_t index = 0; index < ACCESS_TOKEN_LENGTH; index++) {
        difference |= (unsigned char)left[index] ^ (unsigned char)right[index];
    }
    return difference == 0;
}

bool access_login_attempt(access_control_t *control, int64_t now)
{
    if (control == NULL || now < 0) {
        return false;
    }
    if (now < control->login_window || now - control->login_window >= ACCESS_LOGIN_WINDOW_US) {
        control->login_window = now;
        control->login_attempts = 0;
    }
    if (control->login_attempts >= ACCESS_LOGIN_ATTEMPTS) {
        return false;
    }
    control->login_attempts++;
    return true;
}

void access_session_revoke(access_session_t *session)
{
    if (session != NULL) {
        memset(session, 0, sizeof(*session));
    }
}

bool access_session_valid(access_session_t *session, uint32_t generation, int64_t now, bool touch)
{
    if (session == NULL || session->generation == 0 || session->generation != generation) {
        return false;
    }
    if (now < session->last_seen || now < session->created_at ||
        now - session->last_seen >= ACCESS_IDLE_US || now - session->created_at >= ACCESS_ABSOLUTE_US) {
        access_session_revoke(session);
        return false;
    }
    if (touch) {
        session->last_seen = now;
    }
    return true;
}

access_session_t *access_session_create(access_control_t *control, const char *token,
                                        const char *csrf, int64_t now)
{
    if (control == NULL || now < 0 || !token_valid(token) || !token_valid(csrf)) {
        return NULL;
    }
    for (size_t index = 0; index < ACCESS_SESSION_COUNT; index++) {
        access_session_t *session = &control->sessions[index];
        if (access_session_valid(session, session->generation, now, false)) {
            continue;
        }
        access_session_revoke(session);
        if (++control->generation == 0) {
            ++control->generation;
        }
        memcpy(session->token, token, sizeof(session->token));
        memcpy(session->csrf, csrf, sizeof(session->csrf));
        session->generation = control->generation;
        session->created_at = now;
        session->last_seen = now;
        return session;
    }
    return NULL;
}

access_session_t *access_session_find(access_control_t *control, const char *cookie, int64_t now)
{
    if (control == NULL || cookie == NULL || strlen(cookie) > 512) {
        return NULL;
    }
    char token[ACCESS_TOKEN_LENGTH + 1] = {0};
    bool found = false;
    const char *cursor = cookie;
    while (*cursor != '\0') {
        while (*cursor == ' ' || *cursor == '\t') {
            cursor++;
        }
        const char *end = strchr(cursor, ';');
        if (end == NULL) {
            end = cursor + strlen(cursor);
        }
        if ((size_t)(end - cursor) >= 11 && strncmp(cursor, "kb_session=", 11) == 0) {
            if (found || (size_t)(end - cursor) != 11 + ACCESS_TOKEN_LENGTH) {
                return NULL;
            }
            memcpy(token, cursor + 11, ACCESS_TOKEN_LENGTH);
            found = true;
        }
        cursor = *end == '\0' ? end : end + 1;
    }
    if (!found) {
        return NULL;
    }
    for (size_t index = 0; index < ACCESS_SESSION_COUNT; index++) {
        access_session_t *session = &control->sessions[index];
        if (access_token_equal(session->token, token) &&
            access_session_valid(session, session->generation, now, true)) {
            return session;
        }
    }
    return NULL;
}

bool access_credentials_parse(const uint8_t *payload, size_t length, bool claim,
                              access_credentials_t *credentials)
{
    if (credentials == NULL) return false;
    *credentials = (access_credentials_t){0};
    if (payload == NULL || length == 0 || length > ACCESS_CREDENTIAL_BODY_MAX || memchr(payload, 0, length)) return false;
    if (!network_utf8_valid(payload, length)) return false;
    char buffer[ACCESS_CREDENTIAL_BODY_MAX + 1];
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
    unsigned seen = 0;
    const cJSON *field;
    cJSON_ArrayForEach(field, root) {
        unsigned flag = strcmp(field->string, "password") == 0 ? 1 :
                        claim && strcmp(field->string, "setup_code") == 0 ? 2 : 0;
        if (flag == 0 || (seen & flag) != 0 || !cJSON_IsString(field)) goto done;
        seen |= flag;
        size_t count = strlen(field->valuestring);
        if (flag == 1) {
            if (count < 12 || count > 128) goto done;
            memcpy(credentials->password, field->valuestring, count + 1);
        } else {
            if (count != 24) goto done;
            for (size_t index = 0; index < count; index++) {
                char character = field->valuestring[index];
                if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) goto done;
            }
            memcpy(credentials->setup_code, field->valuestring, count + 1);
        }
    }
    valid = seen == (claim ? 3U : 1U);
done:
    cJSON_Delete(root);
    if (!valid) *credentials = (access_credentials_t){0};
    return valid;
}