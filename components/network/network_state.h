#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define NETWORK_HOSTNAME_MAX 32
#define NETWORK_REQUEST_MAX 1024
#define NETWORK_CONNECT_US INT64_C(30000000)
#define NETWORK_HANDOVER_US INT64_C(15000000)

typedef struct {
    uint32_t version;
    uint8_t station;
    char hostname[NETWORK_HOSTNAME_MAX + 1];
    char ssid[33];
    char password[64];
} network_config_t;

typedef enum {
    NETWORK_AP, NETWORK_CONNECTING, NETWORK_STATION, NETWORK_RECOVERY,
    NETWORK_TESTING, NETWORK_CONFIRMING
} network_phase_t;

typedef enum { NETWORK_WAIT, NETWORK_TRY_CONNECT, NETWORK_OPEN_AP, NETWORK_CLOSE_AP } network_effect_t;

typedef struct {
    network_phase_t phase;
    bool ap;
    bool online;
    int64_t deadline;
    int64_t retry_at;
    int64_t handover_at;
    unsigned attempts;
} network_state_t;

typedef enum {
    NETWORK_ACTION_INVALID, NETWORK_ACTION_CONNECT, NETWORK_ACTION_AP,
    NETWORK_ACTION_STATION, NETWORK_ACTION_FORGET, NETWORK_ACTION_RENAME,
    NETWORK_ACTION_CANCEL, NETWORK_ACTION_CONFIRM
} network_action_t;

typedef struct {
    network_action_t action;
    char ssid[33];
    char password[64];
    char hostname[NETWORK_HOSTNAME_MAX + 1];
} network_request_t;

bool network_hostname_valid(const char *hostname);
bool network_config_valid(const network_config_t *configuration);
bool network_config_store(const network_config_t *configuration, uint8_t *active_slot,
                          bool (*stage)(void *, uint8_t, const network_config_t *),
                          bool (*activate)(void *, uint8_t), void *context);
bool network_request_parse(const uint8_t *payload, size_t length, network_request_t *request);
void network_state_init(network_state_t *state, bool station, int64_t now);
void network_state_test(network_state_t *state, int64_t now);
void network_state_online(network_state_t *state);
void network_state_lost(network_state_t *state, int64_t now);
void network_state_recover(network_state_t *state, int64_t now);
bool network_state_confirm(network_state_t *state, int64_t now);
network_effect_t network_state_tick(network_state_t *state, int64_t now, bool held);
const char *network_phase_name(network_phase_t phase);