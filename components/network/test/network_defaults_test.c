#include "network_state.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef int esp_err_t;
typedef int nvs_handle_t;
enum { ESP_OK, ESP_ERR_NVS_NOT_FOUND, ESP_ERR_INVALID_STATE, NVS_READONLY };
static network_config_t saved;
static uint8_t active_slot;
static bool has_record;
static network_config_t persisted = {.version = 1, .hostname = "owner-name"};

static esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle)
{
    assert(strcmp(name, "kb_network") == 0 && mode == NVS_READONLY);
    *handle = 1;
    return has_record ? ESP_OK : ESP_ERR_NVS_NOT_FOUND;
}

static esp_err_t nvs_get_u8(nvs_handle_t handle, const char *key, uint8_t *value)
{
    assert(handle == 1 && strcmp(key, "active") == 0);
    *value = 0;
    return ESP_OK;
}

static esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *record, size_t *length)
{
    assert(handle == 1 && strcmp(key, "slot0") == 0 && *length == sizeof(persisted));
    memcpy(record, &persisted, *length);
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
    puts("PASS: board-specific initial hostname and persisted owner hostname");
}
