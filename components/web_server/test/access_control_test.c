#include "access_control.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static const char *const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
static const char *const csrf = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

int main(void)
{
    const char *allowed[] = {"kb.local", "192.168.4.1"};
    assert(access_host_allowed("KB.LOCAL:80", allowed, 2, false));
    assert(access_origin_allowed("kb.local", "http://kb.local:80", allowed, 2, false));
    assert(access_origin_allowed("192.168.4.1", "http://192.168.4.1", allowed, 2, false));
    assert(access_origin_allowed("kb.local:443", "https://kb.local", allowed, 2, true));
    const char *invalid_origins[] = {
        NULL, "null", "", "http://kb.local.evil", "http://kb.local@evil", "http://evil",
        "https://kb.local", "http://kb.local:8080", "http://kb.local/", "http://kb.local\r\n",
        "http://192.168.4.1", "http://kb.local http://evil",
    };
    for (size_t index = 0; index < sizeof(invalid_origins) / sizeof(invalid_origins[0]); index++) {
        assert(!access_origin_allowed("kb.local", invalid_origins[index], allowed, 2, false));
    }
    assert(!access_origin_allowed("evil", "http://evil", allowed, 2, false));
    assert(!access_host_allowed(NULL, allowed, 2, false));
    assert(!access_host_allowed("kb.local:81", allowed, 2, false));
    assert(!access_host_allowed("kb.local:80:80", allowed, 2, false));
    assert(access_token_equal(token, token));
    assert(!access_token_equal(token, csrf));
    assert(!access_token_equal(NULL, token));
    assert(!access_token_equal("", ""));

    access_control_t control = {0};
    for (unsigned attempt = 0; attempt < ACCESS_LOGIN_ATTEMPTS; attempt++) {
        assert(access_login_attempt(&control, 0));
    }
    assert(!access_login_attempt(&control, ACCESS_LOGIN_WINDOW_US - 1));
    assert(access_login_attempt(&control, ACCESS_LOGIN_WINDOW_US));
    assert(!access_login_attempt(&control, -1));

    access_session_t *session = access_session_create(&control, token, csrf, 0);
    assert(session != NULL);
    uint32_t generation = session->generation;
    char cookie[256];
    snprintf(cookie, sizeof(cookie), "other=value; kb_session=%s; last=value", token);
    assert(access_session_find(&control, cookie, 1) == session);
    assert(access_token_equal(session->csrf, csrf));
    snprintf(cookie, sizeof(cookie), "kb_session=%s; kb_session=%s", token, token);
    assert(access_session_find(&control, cookie, 2) == NULL);
    assert(access_session_find(&control, "kb_session=short", 2) == NULL);
    assert(access_session_find(&control, "other=value", 2) == NULL);
    assert(access_session_find(&control, NULL, 2) == NULL);
    assert(!access_session_valid(session, generation + 1, 2, true));
    assert(access_session_valid(session, generation, ACCESS_IDLE_US, false));
    assert(!access_session_valid(session, generation, ACCESS_IDLE_US + 1, false));
    assert(session->generation == 0 && session->token[0] == '\0');

    session = access_session_create(&control, token, csrf, 0);
    assert(session != NULL && session->generation != generation);
    assert(!access_session_valid(session, generation, 1, true));
    generation = session->generation;
    for (int64_t now = ACCESS_IDLE_US - 1; now < ACCESS_ABSOLUTE_US; now += ACCESS_IDLE_US - 1) {
        assert(access_session_valid(session, generation, now, true));
    }
    assert(!access_session_valid(session, generation, ACCESS_ABSOLUTE_US, true));
    for (size_t index = 0; index < ACCESS_SESSION_COUNT; index++) {
        assert(access_session_create(&control, token, csrf, 0) != NULL);
    }
    assert(access_session_create(&control, token, csrf, 0) == NULL);
    access_session_revoke(&control.sessions[0]);
    assert(access_session_create(&control, "invalid", csrf, 0) == NULL);
    assert(access_session_create(&control, token, csrf, 0) == &control.sessions[0]);
    access_credentials_t credentials;
    const char *login = "{\"password\":\"a-new-owner-password\"}";
    assert(access_credentials_parse((const uint8_t *)login, strlen(login), false, &credentials));
    assert(strcmp(credentials.password, "a-new-owner-password") == 0 && credentials.setup_code[0] == '\0');
    const char *escaped_login = "{\"password\":\"literal\\\\u0000\"}";
    assert(access_credentials_parse((const uint8_t *)escaped_login, strlen(escaped_login), false, &credentials));
    assert(strcmp(credentials.password, "literal\\u0000") == 0);
    assert(!access_credentials_parse((const uint8_t *)login, strlen(login), true, &credentials));
    const char *claim = "{\"setup_code\":\"0123456789abcdef01234567\",\"password\":\"a-new-owner-password\"}";
    assert(access_credentials_parse((const uint8_t *)claim, strlen(claim), true, &credentials));
    assert(!access_credentials_parse((const uint8_t *)claim, strlen(claim), false, &credentials));
    const char *invalid_credentials[] = {
        "{}", "[]", "null", "{\"password\":\"short\"}", "{\"password\":false}",
        "{\"password\":\"a-new-owner-password\",\"password\":\"a-new-owner-password\"}",
        "{\"password\":\"a-new-owner-password\",\"unknown\":1}",
        "{\"password\":\"a-new-owner-password\\u0000ignored\"}",
        "{\"password\":\"a-new-owner-password\\\\\\u0000ignored\"}",
        "{\"password\":\"a-new-owner-password\"} {}",
    };
    for (size_t index = 0; index < sizeof(invalid_credentials) / sizeof(invalid_credentials[0]); index++) {
        assert(!access_credentials_parse((const uint8_t *)invalid_credentials[index], strlen(invalid_credentials[index]), false, &credentials));
        assert(credentials.password[0] == '\0' && credentials.setup_code[0] == '\0');
    }
    assert(!access_credentials_parse(NULL, 0, false, &credentials));
    assert(!access_credentials_parse((const uint8_t *)login, SIZE_MAX, false, &credentials));
    puts("access_control: host/origin, cookies, token checks, login limits and session deadlines passed");
    return 0;
}