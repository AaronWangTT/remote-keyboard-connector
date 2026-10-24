#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define NETWORK_HOSTNAME_MAX 32
#define NETWORK_REQUEST_MAX 1024
#define NETWORK_SSID_MAX 32
#define NETWORK_SSID_DISPLAY_MAX (NETWORK_SSID_MAX * 4)
#define NETWORK_CONNECT_US INT64_C(30000000)
#define NETWORK_HANDOVER_US INT64_C(15000000)
#define NETWORK_CONFIRM_US INT64_C(60000000)
#define NETWORK_PROFILE_LIMIT 10

typedef struct {
    char ssid[NETWORK_SSID_MAX + 1];
    char password[64];
    uint8_t verified;
} network_profile_t;

typedef struct {
    uint8_t version;
    uint8_t station;
    uint8_t count;
    uint8_t reserved;
    char hostname[NETWORK_HOSTNAME_MAX + 1];
    network_profile_t profiles[NETWORK_PROFILE_LIMIT];
} network_profiles_t;

_Static_assert(sizeof(network_profiles_t) == 1017, "Network profiles must have a stable NVS wire format");

typedef struct {
    uint32_t version;
    uint8_t station;
    char hostname[NETWORK_HOSTNAME_MAX + 1];
    char ssid[NETWORK_SSID_MAX + 1];
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
    char ssid[NETWORK_SSID_MAX + 1];
    char password[64];
    char hostname[NETWORK_HOSTNAME_MAX + 1];
} network_request_t;

bool network_hostname_valid(const char *hostname);
void network_ssid_display(const uint8_t *ssid, size_t length, char output[NETWORK_SSID_DISPLAY_MAX + 1]);
void network_ssid_hex(const uint8_t *ssid, size_t length, char output[NETWORK_SSID_MAX * 2 + 1]);
bool network_config_valid(const network_config_t *configuration);
bool network_profiles_valid(const network_profiles_t *profiles);
bool network_profiles_migrate(const network_config_t *legacy, network_profiles_t *profiles);
int network_profiles_find(const network_profiles_t *profiles, const char *ssid);
bool network_profiles_remember(network_profiles_t *profiles, const network_config_t *configuration);
bool network_profiles_remove(network_profiles_t *profiles, const char *ssid);
bool network_profiles_select(const network_profiles_t *profiles, size_t index, network_config_t *configuration);
bool network_config_store(const network_config_t *configuration, uint8_t *active_slot,
                          bool (*stage)(void *, uint8_t, const network_config_t *),
                          bool (*activate)(void *, uint8_t), void *context);
bool network_request_parse(const uint8_t *payload, size_t length, network_request_t *request);
void network_state_init(network_state_t *state, bool station, int64_t now);
void network_state_test(network_state_t *state, int64_t now);
void network_state_online(network_state_t *state, int64_t now);
void network_state_lost(network_state_t *state, int64_t now);
void network_state_recover(network_state_t *state, int64_t now);
bool network_state_confirm(network_state_t *state, int64_t now);
network_effect_t network_state_tick(network_state_t *state, int64_t now, bool held);
const char *network_phase_name(network_phase_t phase);