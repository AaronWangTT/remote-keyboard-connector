#include "network_state.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef int esp_err_t;
typedef int nvs_handle_t;
enum { ESP_OK, ESP_ERR_NVS_NOT_FOUND, ESP_ERR_INVALID_STATE, NVS_READONLY };
static network_config_t saved;
static network_profiles_t profiles;
static bool profiles_persisted;
static uint8_t active_slot;
static bool has_record;
static bool has_profiles;
static bool corrupt_profiles;
static uint8_t new_slot;
static network_config_t persisted = {.version = 1, .hostname = "owner-name"};
static network_profiles_t persisted_profiles;

static esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle)
{
    assert(strcmp(name, "kb_network") == 0 && mode == NVS_READONLY);
    *handle = 1;
    return has_record ? ESP_OK : ESP_ERR_NVS_NOT_FOUND;
}

static esp_err_t nvs_get_u8(nvs_handle_t handle, const char *key, uint8_t *value)
{
    assert(handle == 1);
    if (strcmp(key, "profiles_active") == 0) {
        if (!has_profiles) return ESP_ERR_NVS_NOT_FOUND;
        *value = new_slot;
        return ESP_OK;
    }
    assert(strcmp(key, "active") == 0);
    *value = 0;
    return ESP_OK;
}

static esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *record, size_t *length)
{
    assert(handle == 1);
    if (strcmp(key, "slot0") == 0) {
        assert(*length == sizeof(persisted));
        memcpy(record, &persisted, *length);
    } else {
        assert(strcmp(key, "profiles1") == 0 && *length == sizeof(persisted_profiles));
        memcpy(record, &persisted_profiles, *length);
        if (corrupt_profiles) ((network_profiles_t *)record)->reserved = 1;
    }
    return ESP_OK;
}

static void nvs_close(nvs_handle_t handle) { assert(handle == 1); }
static void mbedtls_platform_zeroize(void *record, size_t length) { memset(record, 0, length); }

#include "network_defaults.inc"

int main(void)
{
    assert(load_configuration() == ESP_OK);
    assert(strcmp(saved.hostname, CONFIG_NETWORK_DEFAULT_HOSTNAME) == 0);
    assert(network_hostname_valid(saved.hostname));
    has_record = true;
    assert(load_configuration() == ESP_OK);
    assert(strcmp(saved.hostname, "owner-name") == 0);
    assert(profiles.count == 0 && profiles.version == 2);
    persisted = (network_config_t){.version = 1, .hostname = "old-name", .station = 1, .ssid = "old-network", .password = "test-password"};
    assert(load_configuration() == ESP_OK);
    assert(profiles.count == 1 && profiles.profiles[0].verified && strcmp(saved.ssid, "old-network") == 0);
    network_config_t new_configuration = {.version = 1, .hostname = "new-name", .station = 1, .ssid = "new-network", .password = "new-password"};
    assert(network_profiles_migrate(&new_configuration, &persisted_profiles));
    has_profiles = true;
    new_slot = 1;
    persisted.version = 255;
    assert(load_configuration() == ESP_OK);
    assert(active_slot == 1 && strcmp(saved.ssid, "new-network") == 0 && strcmp(saved.hostname, "new-name") == 0);
    corrupt_profiles = true;
    assert(load_configuration() == ESP_ERR_INVALID_STATE);
    corrupt_profiles = false;
    new_slot = 2;
    assert(load_configuration() == ESP_ERR_INVALID_STATE);
    puts("PASS: board-specific initial hostname and persisted owner hostname");
}
