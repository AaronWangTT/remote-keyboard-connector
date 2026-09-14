#include "network_state.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    network_config_t slots[2];
    uint8_t active;
    unsigned calls;
    unsigned failure;
} test_store_t;

static bool stage(void *context, uint8_t slot, const network_config_t *configuration)
{
    test_store_t *store = context;
    assert(store->calls++ == 0);
    if (store->failure == 1) return false;
    store->slots[slot] = *configuration;
    return store->failure != 2;
}

static bool activate(void *context, uint8_t slot)
{
    test_store_t *store = context;
    assert(store->calls++ == 1);
    if (store->failure == 3) return false;
    store->active = slot;
    return store->failure != 4;
}

int main(void)
{
    network_config_t old_profile = {.version = 1, .station = 1, .hostname = "kb", .ssid = "old-network", .password = "old-password"};
    network_config_t new_profile = {.version = 1, .station = 1, .hostname = "kb", .ssid = "new-network", .password = "new-password"};
    for (unsigned failure = 0; failure <= 4; failure++) {
        test_store_t store = {.slots = {old_profile}, .active = 0, .failure = failure};
        uint8_t active = store.active;
        bool stored = network_config_store(&new_profile, &active, stage, activate, &store);
        assert(stored == (failure == 0));
        assert(active == (stored ? 1 : 0));
        const network_config_t *rebooted = &store.slots[store.active];
        assert(network_config_valid(rebooted));
        assert(memcmp(rebooted, &old_profile, sizeof(old_profile)) == 0 ||
               memcmp(rebooted, &new_profile, sizeof(new_profile)) == 0);
        assert(store.calls == (failure == 1 || failure == 2 ? 1U : 2U));
    }
    test_store_t store = {.slots = {old_profile}};
    uint8_t corrupt_slot = 255;
    assert(!network_config_store(&new_profile, &corrupt_slot, stage, activate, &store));
    assert(store.calls == 0);
    network_config_t configuration = { .version = 1, .hostname = "kb" };
    assert(network_config_valid(&configuration));
    configuration.station = 255;
    assert(!network_config_valid(&configuration));
    configuration.station = true;
    assert(!network_config_valid(&configuration));
    strcpy(configuration.ssid, "My network");
    strcpy(configuration.password, "network-test-password");
    assert(network_config_valid(&configuration));
    for (size_t index = 0; index < sizeof(configuration.hostname); index++) configuration.hostname[index] = 'a';
    assert(!network_config_valid(&configuration));
    assert(network_hostname_valid("kb-2"));
    const char *bad_hosts[] = {"", "kb.local", "-kb", "kb-", "KB", "localhost", "kb/", "kb:80"};
    for (size_t index = 0; index < sizeof(bad_hosts) / sizeof(bad_hosts[0]); index++) assert(!network_hostname_valid(bad_hosts[index]));
    network_request_t request;
    const char *valid[] = {
        "{\"action\":\"connect\",\"ssid\":\"My network\",\"password\":\"test-password\"}",
        "{\"action\":\"rename\",\"hostname\":\"kb-2\"}", "{\"action\":\"ap\"}",
        "{\"action\":\"station\"}", "{\"action\":\"cancel\"}", "{\"action\":\"confirm\"}", "{\"action\":\"forget\"}"
    };
    for (size_t index = 0; index < sizeof(valid) / sizeof(valid[0]); index++) assert(network_request_parse((const uint8_t *)valid[index], strlen(valid[index]), &request));
    const char *invalid[] = {
        "{}", "[]", "null", "{\"action\":\"open\"}", "{\"action\":\"ap\",\"action\":\"ap\"}",
        "{\"action\":\"rename\",\"hostname\":\"kb.local\"}", "{\"action\":\"ap\",\"password\":\"test-password\"}",
        "{\"action\":\"connect\",\"ssid\":\"network\",\"password\":\"\"}",
        "{\"action\":\"connect\",\"ssid\":\"\",\"password\":\"test-password\"}",
        "{\"action\":\"connect\",\"ssid\":\"network\\u0000ignored\",\"password\":\"test-password\"}",
        "{\"action\":\"ap\"} {}"
    };
    for (size_t index = 0; index < sizeof(invalid) / sizeof(invalid[0]); index++) {
        assert(!network_request_parse((const uint8_t *)invalid[index], strlen(invalid[index]), &request));
        assert(request.action == NETWORK_ACTION_INVALID && request.password[0] == 0);
    }
    assert(!network_request_parse(NULL, 1, &request));
    assert(!network_request_parse((const uint8_t *)valid[0], SIZE_MAX, &request));
    network_state_t state;
    network_state_init(&state, false, 0);
    assert(network_state_tick(&state, INT64_C(90000000), false) == NETWORK_WAIT && state.ap);
    network_state_init(&state, true, 0);
    assert(network_state_tick(&state, 0, false) == NETWORK_TRY_CONNECT);
    assert(network_state_tick(&state, 999999, false) == NETWORK_WAIT);
    assert(network_state_tick(&state, NETWORK_CONNECT_US, false) == NETWORK_OPEN_AP);
    assert(state.phase == NETWORK_RECOVERY && state.ap);
    assert(network_state_tick(&state, NETWORK_CONNECT_US * 2, true) == NETWORK_WAIT);
    assert(network_state_tick(&state, NETWORK_CONNECT_US * 2, false) == NETWORK_TRY_CONNECT);
    network_state_online(&state);
    assert(network_state_tick(&state, NETWORK_CONNECT_US * 2, true) == NETWORK_WAIT);
    assert(network_state_tick(&state, NETWORK_CONNECT_US * 2, false) == NETWORK_CLOSE_AP);
    assert(!state.ap && state.phase == NETWORK_STATION);
    network_state_lost(&state, INT64_C(90000000));
    assert(!state.online && state.phase == NETWORK_CONNECTING);
    network_state_test(&state, 0);
    assert(state.ap && state.phase == NETWORK_TESTING);
    network_state_online(&state);
    assert(state.phase == NETWORK_CONFIRMING);
    assert(network_state_tick(&state, NETWORK_CONNECT_US * 3, false) == NETWORK_WAIT);
    assert(network_state_confirm(&state, NETWORK_CONNECT_US * 3));
    assert(network_state_tick(&state, NETWORK_CONNECT_US * 3 + NETWORK_HANDOVER_US - 1, true) == NETWORK_WAIT);
    assert(network_state_tick(&state, NETWORK_CONNECT_US * 3 + NETWORK_HANDOVER_US, true) == NETWORK_CLOSE_AP);
    assert(strcmp(network_phase_name(state.phase), "station") == 0);
    puts("network_state: schema, interrupted saves, boot mode, retries, recovery deferral and confirmed handover passed");
    return 0;
}