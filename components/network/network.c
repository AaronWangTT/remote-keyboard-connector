#include "network.h"
#include "network_state.h"

#include <stdio.h>
#include <string.h>
#include "device_identity.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/ip4_addr.h"
#include "mbedtls/platform_util.h"
#include "mdns.h"
#include "nvs.h"
#include "usb_keyboard.h"

typedef struct {
    network_request_t request;
    bool scan;
    uint32_t job_id;
} network_command_t;

static const char *const TAG = "network";
static const int64_t SCAN_RESULTS_US = INT64_C(30000000);
static const int64_t HOSTNAME_TRANSITION_US = INT64_C(60000000);
static esp_netif_t *ap_interface;
static esp_netif_t *station_interface;
static QueueHandle_t commands;
static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static network_status_t snapshot;
static network_config_t saved;
static network_config_t candidate;
static network_state_t state;
static uint8_t active_slot;
static bool driver_started;
static bool connecting;
static bool command_pending;
static bool storage_fault;
static uint32_t lease_address;
static bool scan_done;
static bool scanning;
static bool testing;
static bool ap_reconnect_pending;
static bool ap_reconnect_confirmed;
static bool guarded;
static bool guard_ap;
static uint32_t guard_generation;
static uint32_t ap_address;
static uint32_t station_address;
static int64_t management_until;
static int64_t scan_deadline;
static int64_t scan_expires;
static int64_t hostname_transition_until;
static char last_failure[40];

static void disarm(bool only_ap, bool only_station)
{
    uint32_t generation = 0;
    portENTER_CRITICAL(&lock);
    if (guarded && (!only_ap || guard_ap) && (!only_station || !guard_ap)) {
        generation = guard_generation;
        guarded = false;
    }
    portEXIT_CRITICAL(&lock);
    if (generation != 0) usb_keyboard_release(generation);
}

void network_status(network_status_t *status)
{
    int64_t now = esp_timer_get_time();
    portENTER_CRITICAL(&lock);
    if (scan_expires != 0 && now >= scan_expires) {
        snapshot.scan_count = 0;
        scan_expires = 0;
    }
    if (hostname_transition_until != 0 && now >= hostname_transition_until) {
        snapshot.previous_hostname[0] = '\0';
        hostname_transition_until = 0;
    }
    *status = snapshot;
    portEXIT_CRITICAL(&lock);
}

void network_management_touch(uint32_t local_address)
{
    portENTER_CRITICAL(&lock);
    if (snapshot.ap_active && local_address == ap_address) management_until = esp_timer_get_time() + INT64_C(60000000);
    portEXIT_CRITICAL(&lock);
}

bool network_control_begin(uint32_t local_address, uint32_t generation)
{
    portENTER_CRITICAL(&lock);
    bool valid = snapshot.available && snapshot.can_control && !snapshot.busy && !guarded &&
                 local_address != 0 && (local_address == ap_address || local_address == station_address);
    if (valid) {
        guarded = true;
        guard_ap = local_address == ap_address;
        guard_generation = generation;
    }
    portEXIT_CRITICAL(&lock);
    return valid;
}

void network_control_end(uint32_t generation)
{
    portENTER_CRITICAL(&lock);
    if (guarded && generation == guard_generation) guarded = false;
    portEXIT_CRITICAL(&lock);
}

static bool recovery_held(void)
{
    portENTER_CRITICAL(&lock);
    bool held = (guarded && guard_ap) || esp_timer_get_time() < management_until;
    portEXIT_CRITICAL(&lock);
    return held;
}

static void job_result(const char *job, const char *error, bool busy)
{
    portENTER_CRITICAL(&lock);
    snprintf(snapshot.job, sizeof(snapshot.job), "%s", job);
    snprintf(snapshot.error, sizeof(snapshot.error), "%s", error != NULL ? error : "");
    snapshot.busy = busy;
    portEXIT_CRITICAL(&lock);
}

static esp_err_t load_configuration(void)
{
    saved = (network_config_t){.version = 1, .hostname = "kb"};
    active_slot = 0;
    nvs_handle_t handle;
    esp_err_t result = nvs_open("kb_network", NVS_READONLY, &handle);
    if (result == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (result != ESP_OK) return result;
    result = nvs_get_u8(handle, "active", &active_slot);
    if (result == ESP_ERR_NVS_NOT_FOUND) result = ESP_OK;
    else if (result == ESP_OK && active_slot > 1) {
        active_slot = 0;
        result = ESP_ERR_INVALID_STATE;
    }
    else if (result == ESP_OK) {
        network_config_t record = {0};
        size_t length = sizeof(record);
        result = nvs_get_blob(handle, active_slot ? "slot1" : "slot0", &record, &length);
        if (result == ESP_OK && (length != sizeof(record) || !network_config_valid(&record))) result = ESP_ERR_INVALID_STATE;
        if (result == ESP_OK) saved = record;
        mbedtls_platform_zeroize(&record, sizeof(record));
    }
    nvs_close(handle);
    return result;
}

static bool stage_configuration(void *context, uint8_t slot, const network_config_t *configuration)
{
    nvs_handle_t handle = *(nvs_handle_t *)context;
    return nvs_set_blob(handle, slot ? "slot1" : "slot0", configuration, sizeof(*configuration)) == ESP_OK &&
           nvs_commit(handle) == ESP_OK;
}

static bool activate_configuration(void *context, uint8_t slot)
{
    nvs_handle_t handle = *(nvs_handle_t *)context;
    return nvs_set_u8(handle, "active", slot) == ESP_OK && nvs_commit(handle) == ESP_OK;
}

static esp_err_t save_configuration(const network_config_t *configuration)
{
    if (storage_fault) return ESP_ERR_INVALID_STATE;
    if (!network_config_valid(configuration)) return ESP_ERR_INVALID_ARG;
    nvs_handle_t handle;
    esp_err_t result = nvs_open("kb_network", NVS_READWRITE, &handle);
    if (result != ESP_OK) return result;
    result = network_config_store(configuration, &active_slot, stage_configuration, activate_configuration, &handle) ? ESP_OK : ESP_FAIL;
    nvs_close(handle);
    if (result == ESP_OK) {
        saved = *configuration;
    } else {
        storage_fault = true;
    }
    return result;
}

static void wifi_event(void *argument, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)argument;
    if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP && event_data != NULL) {
        const ip_event_got_ip_t *event = event_data;
        if (event->esp_netif == station_interface) {
            portENTER_CRITICAL(&lock);
            lease_address = event->ip_info.ip.addr;
            connecting = false;
            last_failure[0] = '\0';
            portEXIT_CRITICAL(&lock);
            if (event->ip_changed) disarm(false, true);
        }
    }
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_AP_STADISCONNECTED) disarm(true, false);
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_SCAN_DONE) {
        portENTER_CRITICAL(&lock);
        scan_done = true;
        portEXIT_CRITICAL(&lock);
    }
    if ((base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) ||
        (base == IP_EVENT && event_id == IP_EVENT_STA_LOST_IP)) {
        disarm(false, true);
        const char *failure = "connection_failed";
        if (base == WIFI_EVENT && event_data != NULL) {
            uint16_t reason = ((wifi_event_sta_disconnected_t *)event_data)->reason;
            if (reason == WIFI_REASON_AUTH_FAIL || reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT || reason == WIFI_REASON_HANDSHAKE_TIMEOUT) failure = "authentication_failed";
            else if (reason == WIFI_REASON_NO_AP_FOUND) failure = "network_not_found";
        }
        portENTER_CRITICAL(&lock);
        connecting = false;
        lease_address = 0;
        snapshot.can_control = snapshot.ap_active && !snapshot.busy && !(guarded && !guard_ap);
        snprintf(last_failure, sizeof(last_failure), "%s", failure);
        portEXIT_CRITICAL(&lock);
    }
}

static void hostname_changed(const char *hostname, void *argument)
{
    (void)argument;
    int64_t now = esp_timer_get_time();
    portENTER_CRITICAL(&lock);
    if (snapshot.hostname[0] != '\0' && strcmp(snapshot.hostname, hostname) != 0) {
        memcpy(snapshot.previous_hostname, snapshot.hostname, sizeof(snapshot.previous_hostname));
        hostname_transition_until = now + HOSTNAME_TRANSITION_US;
    }
    snprintf(snapshot.hostname, sizeof(snapshot.hostname), "%s", hostname);
    portEXIT_CRITICAL(&lock);
    disarm(false, false);
}

static esp_err_t configure_driver(bool ap, bool station, const network_config_t *configuration)
{
    disarm(false, false);
    esp_err_t result = ESP_OK;
    if (driver_started) result = esp_wifi_stop();
    if (result != ESP_OK) return result;
    driver_started = false;
    portENTER_CRITICAL(&lock);
    connecting = false;
    lease_address = 0;
    station_address = 0;
    snapshot.station_online = false;
    portEXIT_CRITICAL(&lock);
    result = esp_wifi_set_mode(station ? (ap ? WIFI_MODE_APSTA : WIFI_MODE_STA) : WIFI_MODE_AP);
    if (result != ESP_OK) return result;
    if (ap) {
        wifi_config_t access_point = {.ap = {.channel = 1, .authmode = WIFI_AUTH_WPA2_PSK, .max_connection = 1}};
        const char *identity = device_identity_id();
        access_point.ap.ssid_len = snprintf((char *)access_point.ap.ssid, sizeof(access_point.ap.ssid), "WiFiKeyboard-%s", identity + 6);
        for (size_t index = 13; index < access_point.ap.ssid_len; index++) {
            if (access_point.ap.ssid[index] >= 'a' && access_point.ap.ssid[index] <= 'f') access_point.ap.ssid[index] -= 'a' - 'A';
        }
        memcpy(access_point.ap.password, device_identity_ap_password(), strlen(device_identity_ap_password()) + 1);
        result = esp_wifi_set_config(WIFI_IF_AP, &access_point);
        mbedtls_platform_zeroize(access_point.ap.password, sizeof(access_point.ap.password));
        if (result != ESP_OK) return result;
    }
    if (station) {
        wifi_config_t station_config = {.sta = {.threshold.authmode = WIFI_AUTH_WPA2_PSK, .scan_method = WIFI_FAST_SCAN}};
        memcpy(station_config.sta.ssid, configuration->ssid, strlen(configuration->ssid));
        memcpy(station_config.sta.password, configuration->password, strlen(configuration->password));
        result = esp_wifi_set_config(WIFI_IF_STA, &station_config);
        mbedtls_platform_zeroize(&station_config, sizeof(station_config));
        if (result != ESP_OK) return result;
    }
    result = esp_wifi_start();
    driver_started = result == ESP_OK;
    return result;
}

static void refresh_snapshot(void)
{
    esp_netif_ip_info_t ap_info = {0};
    esp_netif_ip_info_t station_info = {0};
    esp_netif_get_ip_info(ap_interface, &ap_info);
    esp_netif_get_ip_info(station_interface, &station_info);
    portENTER_CRITICAL(&lock);
    snapshot.available = driver_started;
    snapshot.ap_active = driver_started && state.ap;
    snapshot.station_online = driver_started && state.online;
    snapshot.desired_station = saved.station != 0;
    snapshot.has_profile = saved.ssid[0] != '\0';
    snapshot.can_control = !snapshot.busy && !command_pending && !scanning && !testing && driver_started &&
                           !(state.phase == NETWORK_RECOVERY && connecting) &&
                           (state.phase == NETWORK_AP || state.phase == NETWORK_RECOVERY || state.phase == NETWORK_STATION);
    snprintf(snapshot.phase, sizeof(snapshot.phase), "%s", network_phase_name(state.phase));
    snprintf(snapshot.requested_hostname, sizeof(snapshot.requested_hostname), "%s", saved.hostname);
    network_ssid_display((const uint8_t *)saved.ssid, strnlen(saved.ssid, NETWORK_SSID_MAX), snapshot.saved_ssid);
    network_ssid_hex((const uint8_t *)saved.ssid, strnlen(saved.ssid, NETWORK_SSID_MAX), snapshot.saved_ssid_hex);
    network_ssid_display((const uint8_t *)saved.ssid, state.online ? strnlen(saved.ssid, NETWORK_SSID_MAX) : 0, snapshot.station_ssid);
    ap_address = snapshot.ap_active ? ap_info.ip.addr : 0;
    station_address = snapshot.station_online ? station_info.ip.addr : 0;
    snapshot.ap_ip[0] = '\0';
    snapshot.station_ip[0] = '\0';
    if (ap_address) snprintf(snapshot.ap_ip, sizeof(snapshot.ap_ip), IPSTR, IP2STR(&ap_info.ip));
    if (station_address) snprintf(snapshot.station_ip, sizeof(snapshot.station_ip), IPSTR, IP2STR(&station_info.ip));
    portEXIT_CRITICAL(&lock);
}

static void clear_ap_reconnect(void)
{
    ap_reconnect_pending = false;
    ap_reconnect_confirmed = false;
    portENTER_CRITICAL(&lock);
    snapshot.ap_reconnect_ip[0] = '\0';
    portEXIT_CRITICAL(&lock);
}

static bool non_overlapping_ap(const esp_netif_ip_info_t *station_info)
{
    esp_netif_ip_info_t current;
    if (esp_netif_get_ip_info(ap_interface, &current) != ESP_OK) {
        clear_ap_reconnect();
        return false;
    }
    if ((current.ip.addr & station_info->netmask.addr) != (station_info->ip.addr & station_info->netmask.addr) &&
        (current.ip.addr & current.netmask.addr) != (station_info->ip.addr & current.netmask.addr)) {
        if (ap_reconnect_pending && state.online) {
            bool confirming = state.phase == NETWORK_CONFIRMING;
            job_result(confirming ? "awaiting_confirmation" : "succeeded", "", confirming);
        }
        clear_ap_reconnect();
        return true;
    }
    const unsigned addresses[][4] = {{192, 168, 4, 1}, {172, 30, 4, 1}, {10, 77, 4, 1}};
    for (size_t index = 0; index < 3; index++) {
        esp_netif_ip_info_t alternative = {0};
        IP4_ADDR(&alternative.ip, addresses[index][0], addresses[index][1], addresses[index][2], addresses[index][3]);
        IP4_ADDR(&alternative.netmask, 255, 255, 255, 0);
        alternative.gw = alternative.ip;
        if ((alternative.ip.addr & station_info->netmask.addr) == (station_info->ip.addr & station_info->netmask.addr) ||
            (alternative.ip.addr & alternative.netmask.addr) == (station_info->ip.addr & alternative.netmask.addr)) continue;
        char reconnect_ip[16];
        snprintf(reconnect_ip, sizeof(reconnect_ip), IPSTR, IP2STR(&alternative.ip));
        if (!ap_reconnect_confirmed || strcmp(snapshot.ap_reconnect_ip, reconnect_ip) != 0) {
            ap_reconnect_pending = true;
            ap_reconnect_confirmed = false;
            portENTER_CRITICAL(&lock);
            memcpy(snapshot.ap_reconnect_ip, reconnect_ip, sizeof(snapshot.ap_reconnect_ip));
            portEXIT_CRITICAL(&lock);
            job_result("awaiting_ap_reconnect", "", true);
            return false;
        }
        disarm(false, false);
        mdns_netif_action(ap_interface, MDNS_EVENT_DISABLE_IP4);
        esp_err_t result = esp_netif_dhcps_stop(ap_interface);
        if (result == ESP_OK) result = esp_netif_set_ip_info(ap_interface, &alternative);
        if (result == ESP_OK) result = esp_netif_dhcps_start(ap_interface);
        if (result != ESP_OK) {
            esp_netif_set_ip_info(ap_interface, &current);
            esp_netif_dhcps_start(ap_interface);
        }
        esp_wifi_deauth_sta(0);
        mdns_netif_action(ap_interface, MDNS_EVENT_ENABLE_IP4);
        clear_ap_reconnect();
        if (result == ESP_OK && state.online) {
            bool confirming = state.phase == NETWORK_CONFIRMING;
            job_result(confirming ? "awaiting_confirmation" : "succeeded", "", confirming);
        }
        return result == ESP_OK;
    }
    clear_ap_reconnect();
    return false;
}

static void recovery(const char *error, bool retry_saved)
{
    testing = false;
    scanning = false;
    clear_ap_reconnect();
    mbedtls_platform_zeroize(&candidate, sizeof(candidate));
    network_state_recover(&state, esp_timer_get_time());
    bool station = retry_saved && saved.station && saved.ssid[0] != '\0';
    esp_err_t result = configure_driver(true, station, &saved);
    if (!station) network_state_init(&state, false, esp_timer_get_time());
    job_result("failed", result == ESP_OK ? error : "wifi_unavailable", false);
}

static bool supported_auth(wifi_auth_mode_t authentication)
{
    return authentication == WIFI_AUTH_WPA2_PSK || authentication == WIFI_AUTH_WPA_WPA2_PSK || authentication == WIFI_AUTH_WPA2_WPA3_PSK;
}

static void finish_scan(void)
{
    wifi_ap_record_t records[NETWORK_SCAN_LIMIT];
    uint16_t count = NETWORK_SCAN_LIMIT;
    esp_err_t result = esp_wifi_scan_get_ap_records(&count, records);
    int64_t expires = result == ESP_OK ? esp_timer_get_time() + SCAN_RESULTS_US : 0;
    portENTER_CRITICAL(&lock);
    snapshot.scan_count = 0;
    if (result == ESP_OK) {
        for (size_t index = 0; index < count; index++) {
            network_scan_item_t *item = &snapshot.scan[snapshot.scan_count++];
            size_t length = strnlen((const char *)records[index].ssid, NETWORK_SSID_MAX);
            network_ssid_display(records[index].ssid, length, item->ssid);
            network_ssid_hex(records[index].ssid, length, item->ssid_hex);
            item->rssi = records[index].rssi;
            item->supported = supported_auth(records[index].authmode);
        }
    }
    scan_expires = expires;
    portEXIT_CRITICAL(&lock);
    scanning = false;
    if (state.phase == NETWORK_AP) esp_wifi_set_mode(WIFI_MODE_AP);
    job_result(result == ESP_OK ? "succeeded" : "failed", result == ESP_OK ? "" : "scan_failed", false);
}

static void run_command(const network_command_t *command)
{
    int64_t now = esp_timer_get_time();
    const network_request_t *request = &command->request;
    if (command->scan) {
        portENTER_CRITICAL(&lock);
        scan_done = false;
        snapshot.scan_count = 0;
        scan_expires = 0;
        portEXIT_CRITICAL(&lock);
        scanning = true;
        scan_deadline = now + INT64_C(15000000);
        wifi_scan_config_t scan = {.show_hidden = true};
        esp_err_t result = ESP_OK;
        if (state.phase == NETWORK_AP) result = esp_wifi_set_mode(WIFI_MODE_APSTA);
        if (result == ESP_OK) result = esp_wifi_scan_start(&scan, false);
        if (result != ESP_OK) {
            scanning = false;
            if (state.phase == NETWORK_AP) esp_wifi_set_mode(WIFI_MODE_AP);
            job_result("failed", "scan_unavailable", false);
        } else job_result("scanning", "", true);
        return;
    }
    if (request->action == NETWORK_ACTION_CONFIRM) {
        if (ap_reconnect_pending) {
            ap_reconnect_confirmed = true;
            state.deadline = now + NETWORK_CONNECT_US;
            job_result("changing_ap_address", "", true);
            return;
        }
        if (network_state_confirm(&state, now)) job_result("handing_over", "", true);
        else job_result("failed", "not_connected", false);
        return;
    }
    if (request->action == NETWORK_ACTION_CANCEL) {
        if (scanning) esp_wifi_scan_stop();
        if (state.online && state.ap) {
            network_config_t keep_ap = saved;
            keep_ap.station = 0;
            esp_err_t result = save_configuration(&keep_ap);
            mbedtls_platform_zeroize(&keep_ap, sizeof(keep_ap));
            if (result != ESP_OK) { recovery("storage_failed", false); return; }
        }
        recovery("", false);
        job_result("cancelled", "", false);
        return;
    }
    if (request->action == NETWORK_ACTION_CONNECT || request->action == NETWORK_ACTION_STATION) {
        candidate = saved;
        if (request->action == NETWORK_ACTION_CONNECT) {
            memcpy(candidate.ssid, request->ssid, sizeof(candidate.ssid));
            memcpy(candidate.password, request->password, sizeof(candidate.password));
        }
        candidate.station = 1;
        if (!network_config_valid(&candidate)) {
            job_result("failed", "no_saved_network", false);
            mbedtls_platform_zeroize(&candidate, sizeof(candidate));
            return;
        }
        testing = true;
        network_state_test(&state, now);
        portENTER_CRITICAL(&lock);
        last_failure[0] = '\0';
        portEXIT_CRITICAL(&lock);
        if (configure_driver(true, true, &candidate) != ESP_OK) recovery("wifi_unavailable", false);
        else job_result("testing", "", true);
        return;
    }
    network_config_t updated = saved;
    if (request->action == NETWORK_ACTION_AP || request->action == NETWORK_ACTION_FORGET) updated.station = 0;
    if (request->action == NETWORK_ACTION_FORGET) {
        mbedtls_platform_zeroize(updated.ssid, sizeof(updated.ssid));
        mbedtls_platform_zeroize(updated.password, sizeof(updated.password));
    }
    if (request->action == NETWORK_ACTION_RENAME) memcpy(updated.hostname, request->hostname, sizeof(updated.hostname));
    esp_err_t result = save_configuration(&updated);
    mbedtls_platform_zeroize(&updated, sizeof(updated));
    if (result != ESP_OK) {
        job_result("failed", "storage_failed", false);
        return;
    }
    if (request->action == NETWORK_ACTION_RENAME) {
        result = mdns_hostname_set(saved.hostname);
        esp_netif_set_hostname(station_interface, saved.hostname);
        esp_netif_set_hostname(ap_interface, saved.hostname);
    } else {
        network_state_init(&state, false, now);
        result = configure_driver(true, false, &saved);
        if (result != ESP_OK) {
            recovery("configuration_failed", false);
            return;
        }
    }
    job_result(result == ESP_OK ? "succeeded" : "failed", result == ESP_OK ? "" : "configuration_failed", false);
}

static void network_worker(void *argument)
{
    (void)argument;
    network_command_t command;
    for (;;) {
        if (xQueueReceive(commands, &command, pdMS_TO_TICKS(250)) == pdTRUE) {
            vTaskDelay(pdMS_TO_TICKS(350));
            run_command(&command);
            mbedtls_platform_zeroize(&command, sizeof(command));
            portENTER_CRITICAL(&lock);
            command_pending = false;
            portEXIT_CRITICAL(&lock);
        }
        int64_t now = esp_timer_get_time();
        if (scanning) {
            portENTER_CRITICAL(&lock);
            bool done = scan_done;
            portEXIT_CRITICAL(&lock);
            if (done) finish_scan();
            else if (now >= scan_deadline) {
                esp_wifi_scan_stop();
                scanning = false;
                if (state.phase == NETWORK_AP) esp_wifi_set_mode(WIFI_MODE_AP);
                job_result("failed", "scan_timeout", false);
            }
            refresh_snapshot();
            continue;
        }
        wifi_ap_record_t association;
        esp_netif_ip_info_t information = {0};
        bool associated = state.phase != NETWORK_AP && esp_wifi_sta_get_ap_info(&association) == ESP_OK;
        portENTER_CRITICAL(&lock);
        uint32_t acquired_address = lease_address;
        portEXIT_CRITICAL(&lock);
        bool online = associated && esp_netif_is_netif_up(station_interface) &&
                      acquired_address != 0 && esp_netif_get_ip_info(station_interface, &information) == ESP_OK &&
                      information.ip.addr == acquired_address;
        if (online && state.online && state.ap && !non_overlapping_ap(&information)) {
            if (ap_reconnect_pending) { refresh_snapshot(); continue; }
            recovery("subnet_overlap", false);
            online = false;
        }
        if (online && !state.online) {
            const network_config_t *expected = testing ? &candidate : &saved;
            if (strncmp((const char *)association.ssid, expected->ssid, 32) != 0 || !supported_auth(association.authmode)) {
                recovery("unsupported_network", false);
            } else if (state.ap && !non_overlapping_ap(&information)) {
                if (ap_reconnect_pending) { refresh_snapshot(); continue; }
                recovery("subnet_overlap", false);
            } else if (testing && save_configuration(&candidate) != ESP_OK) {
                recovery("storage_failed", false);
            } else {
                network_state_online(&state);
                testing = false;
                mbedtls_platform_zeroize(&candidate, sizeof(candidate));
                job_result(state.phase == NETWORK_CONFIRMING ? "awaiting_confirmation" : "succeeded", "", state.phase == NETWORK_CONFIRMING);
            }
        } else if (!online && state.online) {
            disarm(false, true);
            network_state_lost(&state, now);
            job_result("failed", "connection_lost", false);
        }
        bool was_testing = testing;
        network_effect_t effect = network_state_tick(&state, now, recovery_held());
        if (effect == NETWORK_OPEN_AP) {
            char error[40];
            portENTER_CRITICAL(&lock);
            snprintf(error, sizeof(error), "%s", last_failure[0] ? last_failure : associated ? "dhcp_timeout" : "connection_timeout");
            portEXIT_CRITICAL(&lock);
            recovery(error, !was_testing);
        } else if (effect == NETWORK_CLOSE_AP) {
            disarm(true, false);
            if (esp_wifi_set_mode(WIFI_MODE_STA) == ESP_OK) job_result("succeeded", "", false);
            else recovery("handover_failed", true);
        } else if (effect == NETWORK_TRY_CONNECT && !associated) {
            portENTER_CRITICAL(&lock);
            bool pending = connecting || (state.phase == NETWORK_RECOVERY &&
                ((guarded && guard_ap) || now < management_until));
            if (!pending) {
                connecting = true;
                snapshot.can_control = false;
            }
            portEXIT_CRITICAL(&lock);
            if (!pending) {
                esp_err_t result = esp_wifi_connect();
                if (result != ESP_OK) {
                    portENTER_CRITICAL(&lock);
                    connecting = false;
                    portEXIT_CRITICAL(&lock);
                }
            }
        }
        refresh_snapshot();
    }
}

esp_err_t network_submit(const uint8_t *payload, size_t length, bool scan, uint32_t *job_id)
{
    if (commands == NULL || job_id == NULL || !device_identity_claimed()) return ESP_ERR_INVALID_STATE;
    network_command_t command = {.scan = scan};
    if (!scan && !network_request_parse(payload, length, &command.request)) return ESP_ERR_INVALID_ARG;
    portENTER_CRITICAL(&lock);
    bool terminal_action = command.request.action == NETWORK_ACTION_CANCEL || command.request.action == NETWORK_ACTION_CONFIRM;
    bool invalid_confirmation = command.request.action == NETWORK_ACTION_CONFIRM &&
        strcmp(snapshot.job, "awaiting_confirmation") != 0 && strcmp(snapshot.job, "handing_over") != 0 &&
        strcmp(snapshot.job, "awaiting_ap_reconnect") != 0;
    bool invalid_cancellation = command.request.action == NETWORK_ACTION_CANCEL && !snapshot.busy;
    bool busy = !snapshot.available || command_pending || invalid_confirmation || invalid_cancellation ||
                (snapshot.busy && (!terminal_action || strcmp(snapshot.job, "queued") == 0));
    if (!busy) {
        command_pending = true;
        snapshot.busy = true;
        snapshot.can_control = false;
        if (++snapshot.job_id == 0) snapshot.job_id++;
        command.job_id = snapshot.job_id;
        *job_id = snapshot.job_id;
        snprintf(snapshot.job, sizeof(snapshot.job), "queued");
        snapshot.error[0] = '\0';
    }
    portEXIT_CRITICAL(&lock);
    if (busy) {
        mbedtls_platform_zeroize(&command, sizeof(command));
        return ESP_ERR_INVALID_STATE;
    }
    disarm(false, false);
    bool queued = xQueueSend(commands, &command, 0) == pdTRUE;
    mbedtls_platform_zeroize(&command, sizeof(command));
    if (!queued) {
        portENTER_CRITICAL(&lock);
        command_pending = false;
        portEXIT_CRITICAL(&lock);
        job_result("failed", "queue_full", false);
    }
    return queued ? ESP_OK : ESP_ERR_NO_MEM;
}

esp_err_t network_start(void)
{
    ESP_RETURN_ON_ERROR(device_identity_init(), TAG, "Device identity unavailable; no erase or open AP attempted");
    esp_err_t loaded = load_configuration();
    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "Network initialization failed");
    ESP_RETURN_ON_ERROR(esp_event_loop_create_default(), TAG, "Event loop initialization failed");
    ap_interface = esp_netif_create_default_wifi_ap();
    station_interface = esp_netif_create_default_wifi_sta();
    ESP_RETURN_ON_FALSE(ap_interface != NULL && station_interface != NULL, ESP_ERR_NO_MEM, TAG, "Interface allocation failed");
    esp_netif_ip_info_t address = {0};
    IP4_ADDR(&address.ip, 192, 168, 4, 1);
    address.gw = address.ip;
    IP4_ADDR(&address.netmask, 255, 255, 255, 0);
    ESP_RETURN_ON_ERROR(esp_netif_dhcps_stop(ap_interface), TAG, "DHCP stop failed");
    ESP_RETURN_ON_ERROR(esp_netif_set_ip_info(ap_interface, &address), TAG, "AP address setup failed");
    ESP_RETURN_ON_ERROR(esp_netif_dhcps_start(ap_interface), TAG, "DHCP start failed");
    esp_netif_set_hostname(ap_interface, saved.hostname);
    esp_netif_set_hostname(station_interface, saved.hostname);
    wifi_init_config_t initialization = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&initialization), TAG, "Wi-Fi initialization failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "Wi-Fi storage setup failed");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL), TAG, "Wi-Fi event registration failed");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL), TAG, "IP event registration failed");
    network_state_init(&state, saved.station && device_identity_claimed(), esp_timer_get_time());
    ESP_RETURN_ON_ERROR(configure_driver(state.ap, !state.ap, &saved), TAG, "Wi-Fi startup failed");
    snapshot = (network_status_t){0};
    const char *identity = device_identity_id();
    snprintf(snapshot.ap_ssid, sizeof(snapshot.ap_ssid), "WiFiKeyboard-%s", identity + 6);
    for (size_t index = 13; snapshot.ap_ssid[index]; index++) {
        if (snapshot.ap_ssid[index] >= 'a' && snapshot.ap_ssid[index] <= 'f') snapshot.ap_ssid[index] -= 'a' - 'A';
    }
    snprintf(snapshot.hostname, sizeof(snapshot.hostname), "%s", saved.hostname);
    if (mdns_init() == ESP_OK) {
        esp_err_t result = mdns_register_hostname_changed_callback(hostname_changed, NULL);
        if (result == ESP_OK) result = mdns_hostname_set(saved.hostname);
        if (result == ESP_OK) result = mdns_instance_name_set("Wi-Fi Keyboard");
        mdns_txt_item_t text[] = {{"path", "/"}};
        if (result == ESP_OK) result = mdns_service_add(NULL, "_http", "_tcp", 80, text, 1);
        snapshot.mdns = result == ESP_OK;
    }
    job_result(loaded == ESP_OK ? "idle" : "failed", loaded == ESP_OK ? "" : "saved_configuration_invalid", false);
    refresh_snapshot();
    commands = xQueueCreate(1, sizeof(network_command_t));
    ESP_RETURN_ON_FALSE(commands != NULL, ESP_ERR_NO_MEM, TAG, "Network queue allocation failed");
    ESP_RETURN_ON_FALSE(xTaskCreate(network_worker, "keyboard_network", 6144, NULL, 3, NULL) == pdPASS, ESP_ERR_NO_MEM, TAG, "Network worker allocation failed");
    ESP_LOGW(TAG, "HTTP/WS development profile; use a protected, trusted test network only");
    ESP_LOGI(TAG, "Wi-Fi state: %s; preferred name: %s.local", network_phase_name(state.phase), saved.hostname);
    return ESP_OK;
}