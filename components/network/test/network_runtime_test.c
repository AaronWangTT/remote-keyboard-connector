#include "idf_stubs.h"
#include "network.h"
#include "network_state.h"

#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>

#define pdTRUE 1
#define WIFI_MODE_APSTA 1
#define WIFI_MODE_STA 2
typedef struct { bool show_hidden; } wifi_scan_config_t;
typedef struct { char ssid[33]; int authmode; } wifi_ap_record_t;
typedef struct { struct { uint32_t addr; } ip; } esp_netif_ip_info_t;
typedef struct { network_request_t request; bool scan; uint32_t job_id; } network_command_t;

static network_config_t saved, candidate, automatic_configuration, driver_configuration;
static network_profiles_t profiles, slots[2];
static network_state_t state;
static network_status_t snapshot;
static portMUX_TYPE lock;
static uint8_t active_slot, persisted_slot;
static bool storage_fault, saved_configuration_valid, testing, scanning, connecting, command_pending;
static bool profiles_persisted;
static bool ap_reconnect_pending, ap_reconnect_confirmed, ap_restore_pending, driver_retry_pending;
static bool scan_done, update_reserved, guarded, guard_ap, control_ready;
static bool driver_station, driver_ap, associated, lease, held, fail_storage;
static network_sleep_state_t sleep_state;
static size_t automatic_index;
static int64_t automatic_deadline, driver_retry_at, ap_reconnect_until, management_until;
static int64_t scan_deadline, scan_expires, now_us, stop_at;
static const int64_t NETWORK_CONNECT_STEP = INT64_C(250000);
static char last_failure[40];
static uint32_t lease_address;
static int station_interface, commands;
static unsigned connects, configurations, writes;
static char attempted[128][33];
static int64_t attempted_at[128];
static const char *successful_ssid;
static jmp_buf worker_exit;

void test_enter_critical(portMUX_TYPE *mutex) { (void)mutex; }
void test_exit_critical(portMUX_TYPE *mutex) { (void)mutex; }
int64_t esp_timer_get_time(void) { return now_us; }
void vTaskDelay(TickType_t ticks) { now_us += (int64_t)ticks * 1000; }
static void mbedtls_platform_zeroize(void *value, size_t size) { memset(value, 0, size); }

esp_err_t nvs_open(const char *name, nvs_open_mode_t mode, nvs_handle_t *handle)
{
    assert(strcmp(name, "kb_network") == 0 && mode == NVS_READWRITE);
    *handle = 1;
    return ESP_OK;
}
static esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *value, size_t size)
{
    assert(handle == 1 && size == sizeof(profiles));
    assert(strcmp(key, "profiles0") == 0 || strcmp(key, "profiles1") == 0);
    writes++;
    if (fail_storage) return ESP_FAIL;
    slots[strcmp(key, "profiles1") == 0] = *(const network_profiles_t *)value;
    return ESP_OK;
}
static esp_err_t nvs_set_u8(nvs_handle_t handle, const char *key, uint8_t value)
{
    assert(handle == 1 && strcmp(key, "profiles_active") == 0 && value < 2);
    assert(network_profiles_valid(&slots[value]));
    persisted_slot = value;
    return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t handle) { assert(handle == 1); return ESP_OK; }
void nvs_close(nvs_handle_t handle) { assert(handle == 1); }
#include "network_persistence.inc"

static void disarm(bool ap, bool station) { (void)ap; (void)station; }
static void job_result(const char *job, const char *error, bool busy)
{
    snprintf(snapshot.job, sizeof(snapshot.job), "%s", job);
    snprintf(snapshot.error, sizeof(snapshot.error), "%s", error);
    snapshot.busy = busy;
}
static void clear_ap_reconnect(void) { ap_reconnect_pending = ap_reconnect_confirmed = false; }
static esp_err_t restore_ap_address(void) { return ESP_OK; }
static esp_err_t configure_driver(bool ap, bool station, const network_config_t *configuration)
{
    assert(network_config_valid(configuration));
    configurations++;
    driver_configuration = *configuration;
    driver_ap = ap;
    driver_station = station;
    associated = lease = connecting = false;
    lease_address = 0;
    return ESP_OK;
}
#include "network_recovery.inc"

static bool recovery_held(void) { return held || update_reserved || (guarded && guard_ap) || now_us < management_until; }
static bool restore_scan_mode(void) { return true; }
static esp_err_t esp_wifi_set_mode(int mode) { if (mode == WIFI_MODE_STA) driver_ap = false; return ESP_OK; }
static esp_err_t esp_wifi_scan_start(const wifi_scan_config_t *scan, bool block) { (void)scan; (void)block; return ESP_OK; }
static esp_err_t esp_wifi_scan_stop(void) { return ESP_OK; }
static esp_err_t rename_configuration(const network_config_t *configuration) { return save_configuration(configuration); }
#include "network_commands.inc"

static bool sleep_step(void) { return false; }
static bool retry_ap_restoration(int64_t now) { (void)now; return false; }
static void finish_scan(void) { scanning = false; }
static void refresh_snapshot(void) { snapshot.station_online = state.online; snapshot.ap_active = state.ap; }
static bool non_overlapping_ap(const esp_netif_ip_info_t *information) { (void)information; return true; }
static bool supported_auth(int authmode) { return authmode == 2; }
static bool esp_netif_is_netif_up(int interface) { (void)interface; return lease; }
static esp_err_t esp_netif_get_ip_info(int interface, esp_netif_ip_info_t *information)
{
    (void)interface;
    information->ip.addr = lease_address;
    return ESP_OK;
}
static esp_err_t esp_wifi_sta_get_ap_info(wifi_ap_record_t *record)
{
    if (!associated) return ESP_FAIL;
    memcpy(record->ssid, driver_configuration.ssid, sizeof(record->ssid));
    record->authmode = 2;
    return ESP_OK;
}
static esp_err_t esp_wifi_connect(void)
{
    assert(driver_station && connects < 128);
    strcpy(attempted[connects], driver_configuration.ssid);
    attempted_at[connects++] = now_us;
    connecting = false;
    if (successful_ssid && strcmp(successful_ssid, driver_configuration.ssid) == 0) {
        associated = lease = true;
        lease_address = 1;
    }
    return ESP_OK;
}
static int xQueueReceive(int queue, network_command_t *command, unsigned wait)
{
    (void)queue; (void)command; (void)wait;
    if (now_us + NETWORK_CONNECT_STEP > stop_at) longjmp(worker_exit, 1);
    now_us += NETWORK_CONNECT_STEP;
    return 0;
}
#include "network_worker.inc"

static void run_until(int64_t until)
{
    stop_at = until;
    if (setjmp(worker_exit) == 0) network_worker(NULL);
}

static void reset(void)
{
    profiles = (network_profiles_t){.version = 2, .station = 1, .count = 3, .hostname = "kb",
        .profiles = {{.ssid = "recent", .password = "test-password", .verified = 1},
                     {.ssid = "office", .password = "test-password"},
                     {.ssid = "travel", .password = "test-password"}}};
    assert(network_profiles_select(&profiles, 0, &saved));
    automatic_configuration = saved;
    automatic_index = 0;
    automatic_deadline = NETWORK_CONNECT_US;
    storage_fault = testing = scanning = connecting = command_pending = false;
    associated = lease = held = update_reserved = guarded = guard_ap = false;
    ap_restore_pending = driver_retry_pending = ap_reconnect_pending = false;
    successful_ssid = NULL;
    sleep_state = NETWORK_SLEEP_AWAKE;
    snapshot = (network_status_t){0};
    active_slot = persisted_slot = 0;
    writes = connects = configurations = 0;
    profiles_persisted = true;
    now_us = management_until = 0;
    lease_address = 0;
    network_state_init(&state, true, 0);
    configure_driver(false, true, &saved);
}

static void command(network_action_t action, const char *ssid)
{
    network_command_t value = {.request = {.action = action}};
    if (ssid) strcpy(value.request.ssid, ssid);
    if (action == NETWORK_ACTION_CONNECT) strcpy(value.request.password, "test-password");
    run_command(&value);
}

int main(void)
{
    reset();
    run_until(NETWORK_CONNECT_US - NETWORK_CONNECT_STEP);
    for (unsigned index = 0; index < connects; index++) assert(strcmp(attempted[index], "recent") == 0);
    run_until(NETWORK_CONNECT_US * 3 + INT64_C(1000000));
    assert(driver_ap && strcmp(attempted[connects - 1], "recent") == 0);
    bool office = false, travel = false;
    for (unsigned index = 0; index < connects; index++) {
        if (strcmp(attempted[index], "office") == 0) {
            assert(attempted_at[index] >= NETWORK_CONNECT_US);
            office = true;
        }
        if (strcmp(attempted[index], "travel") == 0) {
            assert(attempted_at[index] >= NETWORK_CONNECT_US * 2);
            travel = true;
        }
    }
    assert(office && travel && writes == 0 && profiles.count == 3);

    reset();
    profiles_persisted = false;
    successful_ssid = "recent";
    run_until(INT64_C(2000000));
    assert(state.online && profiles_persisted && writes == 1);
    run_until(INT64_C(4000000));
    assert(writes == 1);

    reset();
    successful_ssid = "office";
    run_until(NETWORK_CONNECT_US + INT64_C(1000000));
    assert(state.online && strcmp(saved.ssid, "office") == 0);
    assert(profiles.profiles[0].verified && strcmp(profiles.profiles[0].ssid, "office") == 0);
    assert(strcmp(profiles.profiles[1].ssid, "recent") == 0 && writes == 1);
    assert(network_profiles_valid(&slots[persisted_slot]));
    unsigned online_connects = connects;
    run_until(NETWORK_CONNECT_US * 5);
    assert(connects == online_connects && writes == 1);
    associated = lease = false;
    lease_address = 0;
    run_until(now_us + INT64_C(2000000));
    assert(strcmp(attempted[connects - 1], "office") == 0 && state.online);

    reset();
    management_until = NETWORK_CONNECT_US * 4;
    recovery("network_not_found", true);
    run_until(NETWORK_CONNECT_US * 4 - NETWORK_CONNECT_STEP);
    assert(connects == 0);
    run_until(NETWORK_CONNECT_US * 4 + INT64_C(1000000));
    assert(connects == 1 && strcmp(attempted[0], "recent") == 0);

    reset();
    command(NETWORK_ACTION_STATION, "travel");
    assert(testing && strcmp(candidate.ssid, "travel") == 0);
    successful_ssid = "travel";
    run_until(INT64_C(2000000));
    assert(state.online && strcmp(saved.ssid, "travel") == 0 && profiles.count == 3);
    command(NETWORK_ACTION_FORGET, "recent");
    assert(state.online && strcmp(saved.ssid, "travel") == 0 && profiles.count == 2);
    command(NETWORK_ACTION_FORGET, "travel");
    assert(!state.online && state.ap && !profiles.station && profiles.count == 1);
    assert(strcmp(saved.ssid, "office") == 0);
    command(NETWORK_ACTION_FORGET, "office");
    assert(profiles.count == 0 && !profiles.station && saved.ssid[0] == '\0');

    reset();
    network_profiles_t before = profiles;
    command(NETWORK_ACTION_CONNECT, "bad-network");
    run_until(NETWORK_CONNECT_US + INT64_C(1000000));
    assert(!testing && state.ap && !state.online);
    assert(memcmp(&profiles, &before, sizeof(profiles)) == 0 && writes == 0);

    reset();
    successful_ssid = "travel";
    fail_storage = true;
    command(NETWORK_ACTION_STATION, "travel");
    run_until(INT64_C(2000000));
    assert(storage_fault && !state.online && state.ap);
    assert(strcmp(saved.ssid, "recent") == 0 && active_slot == 0);
    fail_storage = false;

    reset();
    for (size_t index = profiles.count; index < 10; index++) {
        network_config_t added = {.version = 1, .station = 1, .hostname = "kb", .password = "test-password"};
        snprintf(added.ssid, sizeof(added.ssid), "extra-%zu", index);
        assert(network_profiles_remember(&profiles, &added));
    }
    unsigned previous_configurations = configurations;
    command(NETWORK_ACTION_CONNECT, "eleventh");
    assert(strcmp(snapshot.error, "profile_limit_reached") == 0 && configurations == previous_configurations);
    command(NETWORK_ACTION_CONNECT, "office");
    assert(testing && strcmp(candidate.ssid, "office") == 0);
    puts("PASS: production network worker deadlines, MRU fallback, AP protection, manual switching, deletion, capacity and failed writes");
}
