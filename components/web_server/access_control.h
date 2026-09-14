#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ACCESS_TOKEN_LENGTH 64
#define ACCESS_SESSION_COUNT 4
#define ACCESS_IDLE_US INT64_C(900000000)
#define ACCESS_ABSOLUTE_US INT64_C(28800000000)
#define ACCESS_LOGIN_WINDOW_US INT64_C(60000000)
#define ACCESS_LOGIN_ATTEMPTS 5
#define ACCESS_CREDENTIAL_BODY_MAX 1024

typedef struct {
    char password[129];
    char setup_code[25];
} access_credentials_t;

typedef struct {
    char token[ACCESS_TOKEN_LENGTH + 1];
    char csrf[ACCESS_TOKEN_LENGTH + 1];
    uint32_t generation;
    int64_t created_at;
    int64_t last_seen;
} access_session_t;

typedef struct {
    access_session_t sessions[ACCESS_SESSION_COUNT];
    uint32_t generation;
    int64_t login_window;
    unsigned login_attempts;
} access_control_t;

bool access_host_allowed(const char *host, const char *const *allowed, size_t count, bool secure);
bool access_origin_allowed(const char *host, const char *origin,
                           const char *const *allowed, size_t count, bool secure);
bool access_token_equal(const char *left, const char *right);
bool access_login_attempt(access_control_t *control, int64_t now);
access_session_t *access_session_create(access_control_t *control, const char *token,
                                        const char *csrf, int64_t now);
access_session_t *access_session_find(access_control_t *control, const char *cookie, int64_t now);
bool access_session_valid(access_session_t *session, uint32_t generation, int64_t now, bool touch);
void access_session_revoke(access_session_t *session);
bool access_credentials_parse(const uint8_t *payload, size_t length, bool claim,
                              access_credentials_t *credentials);