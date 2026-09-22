#include "web_server.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <inttypes.h>

#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "access_control.h"
#include "cJSON.h"
#include "device_identity.h"
#include "firmware_update.h"
#include "input_protocol.h"
#include "mbedtls/platform_util.h"
#include "lwip/sockets.h"
#include "network.h"
#include "power_control.h"
#include "usb_keyboard.h"

extern const char index_start[] asm("_binary_index_html_start");
extern const char index_end[] asm("_binary_index_html_end");
extern const char ota_html_start[] asm("_binary_ota_html_start");
extern const char ota_html_end[] asm("_binary_ota_html_end");
extern const char ota_script_start[] asm("_binary_ota_mjs_start");
extern const char ota_script_end[] asm("_binary_ota_mjs_end");
extern const char css_start[] asm("_binary_app_css_start");
extern const char css_end[] asm("_binary_app_css_end");
extern const char javascript_start[] asm("_binary_app_mjs_start");
extern const char javascript_end[] asm("_binary_app_mjs_end");
extern const char keyboard_start[] asm("_binary_keyboard_mjs_start");
extern const char keyboard_end[] asm("_binary_keyboard_mjs_end");
extern const char shift_start[] asm("_binary_shift_svg_start");
extern const char shift_end[] asm("_binary_shift_svg_end");
extern const char caps_start[] asm("_binary_caps_svg_start");
extern const char caps_end[] asm("_binary_caps_svg_end");
extern const char backspace_start[] asm("_binary_backspace_svg_start");
extern const char backspace_end[] asm("_binary_backspace_svg_end");
extern const char return_start[] asm("_binary_return_svg_start");
extern const char return_end[] asm("_binary_return_svg_end");
extern const char release_start[] asm("_binary_release_svg_start");
extern const char release_end[] asm("_binary_release_svg_end");
extern const char settings_start[] asm("_binary_settings_svg_start");
extern const char settings_end[] asm("_binary_settings_svg_end");
extern const char logout_start[] asm("_binary_logout_svg_start");
extern const char logout_end[] asm("_binary_logout_svg_end");
extern const char eye_start[] asm("_binary_eye_svg_start");
extern const char eye_end[] asm("_binary_eye_svg_end");
extern const char eye_off_start[] asm("_binary_eye_off_svg_start");
extern const char eye_off_end[] asm("_binary_eye_off_svg_end");
extern const char back_start[] asm("_binary_back_svg_start");
extern const char back_end[] asm("_binary_back_svg_end");
extern const char refresh_start[] asm("_binary_refresh_svg_start");
extern const char refresh_end[] asm("_binary_refresh_svg_end");
extern const char globe_start[] asm("_binary_globe_svg_start");
extern const char globe_end[] asm("_binary_globe_svg_end");
extern const char x_start[] asm("_binary_x_svg_start");
extern const char x_end[] asm("_binary_x_svg_end");

typedef struct {
    const char *uri;
    const char *content_type;
    const char *start;
    const char *end;
} web_asset_t;

static const web_asset_t assets[] = {
    {"/", "text/html; charset=utf-8", index_start, index_end},
    {"/ota", "text/html; charset=utf-8", ota_html_start, ota_html_end},
    {"/ota.mjs", "text/javascript; charset=utf-8", ota_script_start, ota_script_end},
    {"/app.css", "text/css; charset=utf-8", css_start, css_end},
    {"/app.mjs", "text/javascript; charset=utf-8", javascript_start, javascript_end},
    {"/keyboard.mjs", "text/javascript; charset=utf-8", keyboard_start, keyboard_end},
    {"/icons/shift.svg", "image/svg+xml", shift_start, shift_end},
    {"/icons/caps.svg", "image/svg+xml", caps_start, caps_end},
    {"/icons/backspace.svg", "image/svg+xml", backspace_start, backspace_end},
    {"/icons/return.svg", "image/svg+xml", return_start, return_end},
    {"/icons/release.svg", "image/svg+xml", release_start, release_end},
    {"/icons/settings.svg", "image/svg+xml", settings_start, settings_end},
    {"/icons/logout.svg", "image/svg+xml", logout_start, logout_end},
    {"/icons/eye.svg", "image/svg+xml", eye_start, eye_end},
    {"/icons/eye-off.svg", "image/svg+xml", eye_off_start, eye_off_end},
    {"/icons/back.svg", "image/svg+xml", back_start, back_end},
    {"/icons/refresh.svg", "image/svg+xml", refresh_start, refresh_end},
    {"/icons/globe.svg", "image/svg+xml", globe_start, globe_end},
    {"/icons/x.svg", "image/svg+xml", x_start, x_end},
};

typedef struct {
    int socket;
    uint32_t generation;
    uint32_t last_sequence;
    int64_t last_seen;
    access_session_t *owner;
    uint32_t owner_generation;
    keyboard_report_t last_report;
} input_client_t;

static input_client_t *active_client;
static httpd_handle_t server;
static access_control_t access_control;
static access_session_t *pending_owner;
static uint32_t pending_generation;
static uint32_t pending_usb_generation;
static int64_t pending_until;
static esp_timer_handle_t control_timer;
static bool server_started;
static TaskHandle_t status_task;
static portMUX_TYPE status_lock = portMUX_INITIALIZER_UNLOCKED;
static bool status_pending;
static web_server_status_t status_snapshot;
static access_session_t *update_owner;
static uint32_t update_owner_generation;
static uint32_t update_owner_address;

static void response_headers(httpd_req_t *request);
static cJSON *network_json(void);
static cJSON *power_json(void);
static void release_control(void);

web_server_status_t web_server_status(void)
{
    portENTER_CRITICAL(&status_lock);
    web_server_status_t status = status_snapshot;
    portEXIT_CRITICAL(&status_lock);
    return status;
}

bool web_server_service_healthy(void)
{
    web_server_status_t current = web_server_status();
    uint64_t now = (uint64_t)(esp_timer_get_time() / 1000);
    return server_started && current.valid && now >= current.sampled_at_ms && now - current.sampled_at_ms < 500;
}

static void publish_status(void *argument)
{
    (void)argument;
    power_control_poll(device_identity_ready() && device_identity_claimed(), pending_owner != NULL, release_control);
    int64_t now = esp_timer_get_time();
    usb_keyboard_status_t usb = usb_keyboard_status();
    network_control_status_t network = network_control_status(active_client != NULL ? active_client->generation : 0);
    access_status_facts_t facts = {
        .web_started = server_started,
        .identity_ready = device_identity_ready(),
        .owner_claimed = device_identity_claimed(),
        .network_ready = network.ready,
        .usb_ready = usb.ready,
        .usb_generation = usb.generation,
        .controller_network_ready = network.controller_path_ready,
    };
    if (active_client != NULL) {
        facts.controller_connected = httpd_ws_get_fd_info(server, active_client->socket) == HTTPD_WS_CLIENT_WEBSOCKET;
        facts.controller_generation = active_client->generation;
        facts.controller_last_seen = active_client->last_seen;
        facts.owner = active_client->owner;
        facts.owner_generation = active_client->owner_generation;
    }
    access_status_t observed = access_control_observe(&facts, now);
    usb_keyboard_status_t current_usb = usb_keyboard_status();
    web_server_status_t status = {
        .valid = current_usb.generation == usb.generation && current_usb.ready == usb.ready,
        .ready = observed.ready,
        .controller_active = observed.controller_active,
        .sampled_at_ms = (uint64_t)(now / 1000),
    };
    portENTER_CRITICAL(&status_lock);
    status_snapshot = status;
    status_pending = false;
    portEXIT_CRITICAL(&status_lock);
}

static void status_worker(void *argument)
{
    httpd_handle_t owner = argument;
    bool queue_failed = false;
    for (;;) {
        portENTER_CRITICAL(&status_lock);
        bool queue = !status_pending;
        status_pending = true;
        portEXIT_CRITICAL(&status_lock);
        if (queue) {
            esp_err_t result = httpd_queue_work(owner, publish_status, NULL);
            if (result != ESP_OK) {
                portENTER_CRITICAL(&status_lock);
                status_snapshot.valid = false;
                status_pending = false;
                portEXIT_CRITICAL(&status_lock);
                if (!queue_failed) ESP_LOGW("web_status", "Status publication failed (%s)", esp_err_to_name(result));
            }
            queue_failed = result != ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(25) > 0 ? pdMS_TO_TICKS(25) : 1);
    }
}

esp_err_t web_server_status_start(void)
{
    if (!server_started || status_task != NULL) return ESP_ERR_INVALID_STATE;
    return xTaskCreate(status_worker, "web_status", 2048, server, tskIDLE_PRIORITY + 1, &status_task) == pdPASS ?
        ESP_OK : ESP_ERR_NO_MEM;
}

static esp_err_t problem(httpd_req_t *request, const char *status, const char *code)
{
    response_headers(request);
    httpd_resp_set_status(request, status);
    httpd_resp_set_type(request, "application/json");
    char response[128];
    snprintf(response, sizeof(response), "{\"error\":\"%s\"}", code);
    return httpd_resp_sendstr(request, response);
}

static bool header(httpd_req_t *request, const char *name, char *value, size_t capacity)
{
    size_t length = httpd_req_get_hdr_value_len(request, name);
    return length > 0 && length < capacity && httpd_req_get_hdr_value_str(request, name, value, capacity) == ESP_OK;
}

static bool request_allowed(httpd_req_t *request, bool mutation)
{
    char host[80];
    char origin[96];
    network_status_t network;
    network_status(&network);
    char hostname[72];
    char previous_hostname[72];
    snprintf(hostname, sizeof(hostname), "%s.local", network.hostname);
    const char *allowed[] = {hostname, network.ap_ip, network.station_ip, previous_hostname};
    size_t allowed_count = 3;
    if (network.previous_hostname[0] != '\0') {
        snprintf(previous_hostname, sizeof(previous_hostname), "%s.local", network.previous_hostname);
        allowed_count++;
    }
    bool valid = header(request, "Host", host, sizeof(host)) &&
                 access_host_allowed(host, allowed, allowed_count, false);
    if (mutation) valid = valid && header(request, "Origin", origin, sizeof(origin)) &&
                          access_origin_allowed(host, origin, allowed, allowed_count, false);
    if (!valid) problem(request, "403 Forbidden", "origin_denied");
    if (valid && mutation && power_control_status().preparing) {
        problem(request, "503 Service Unavailable", "device_sleeping");
        return false;
    }
    return valid;
}

static uint32_t local_address(httpd_req_t *request)
{
    struct sockaddr_storage address = {0};
    socklen_t length = sizeof(address);
    if (getsockname(httpd_req_to_sockfd(request), (struct sockaddr *)&address, &length) != 0) return 0;
    if (address.ss_family == AF_INET) return ((const struct sockaddr_in *)&address)->sin_addr.s_addr;
#if CONFIG_LWIP_IPV6
    if (address.ss_family == AF_INET6) {
        const struct sockaddr_in6 *ipv6 = (const struct sockaddr_in6 *)&address;
        if (IN6_IS_ADDR_V4MAPPED(&ipv6->sin6_addr)) {
            uint32_t ipv4;
            memcpy(&ipv4, &ipv6->sin6_addr.s6_addr[12], sizeof(ipv4));
            return ipv4;
        }
    }
#endif
    return 0;
}

static access_session_t *request_session(httpd_req_t *request, bool mutation)
{
    char cookie[513];
    access_session_t *session = header(request, "Cookie", cookie, sizeof(cookie)) ?
        access_session_find(&access_control, cookie, esp_timer_get_time()) : NULL;
    if (session == NULL) {
        problem(request, "401 Unauthorized", "login_required");
        return NULL;
    }
    if (mutation) {
        char csrf[ACCESS_TOKEN_LENGTH + 1];
        if (!header(request, "X-CSRF-Token", csrf, sizeof(csrf)) || !access_token_equal(csrf, session->csrf)) {
            problem(request, "403 Forbidden", "csrf_denied");
            return NULL;
        }
    }
    if (mutation) network_management_touch(local_address(request));
    return session;
}

static void release_control(void)
{
    if (pending_owner != NULL) network_control_end(pending_usb_generation);
    pending_owner = NULL;
    if (active_client != NULL) {
        input_client_t *previous = active_client;
        active_client = NULL;
        network_control_end(previous->generation);
        usb_keyboard_release(previous->generation);
        httpd_sess_trigger_close(server, previous->socket);
    }
}

static void expire_control(void *argument)
{
    (void)argument;
    int64_t now = esp_timer_get_time();
    firmware_update_tick();
    firmware_update_status_t update = firmware_update_status();
    if (!update.busy) {
        update_owner = NULL;
        update_owner_generation = 0;
        update_owner_address = 0;
    } else if (update_owner != NULL && !access_session_current(update_owner, update_owner_generation, now)) {
        firmware_update_cancel(update.policy.job_id);
    }
    if (pending_owner != NULL && (now >= pending_until || pending_usb_generation != usb_keyboard_status().generation ||
        !access_session_valid(pending_owner, pending_generation, now, false))) {
        network_control_end(pending_usb_generation);
        pending_owner = NULL;
    }
    if (active_client != NULL && (now - active_client->last_seen >= ACCESS_CONTROL_LEASE_US ||
        active_client->generation != usb_keyboard_status().generation ||
        !access_session_valid(active_client->owner, active_client->owner_generation, now, false))) release_control();
}

static void control_tick(void *argument)
{
    (void)argument;
    if (server != NULL) httpd_queue_work(server, expire_control, NULL);
}

static void free_input_client(void *context)
{
    input_client_t *client = context;
    if (active_client == client) {
        network_control_end(client->generation);
        usb_keyboard_release(client->generation);
        active_client = NULL;
    }
    free(client);
}

static esp_err_t input_handshake(httpd_req_t *request)
{
    if (!request_allowed(request, true)) return ESP_FAIL;
    access_session_t *session = request_session(request, false);
    if (session == NULL) return ESP_FAIL;
    int64_t now = esp_timer_get_time();
    expire_control(NULL);
    usb_keyboard_status_t status = usb_keyboard_status();
    if (active_client != NULL) {
        problem(request, "409 Conflict", "busy");
        return ESP_FAIL;
    }
    if (pending_owner != session || pending_generation != session->generation || now >= pending_until) {
        problem(request, "403 Forbidden", "take_control_required");
        return ESP_FAIL;
    }
    pending_owner = NULL;
    if (!status.ready || pending_usb_generation != status.generation) {
        network_control_end(pending_usb_generation);
        problem(request, "503 Service Unavailable", "usb_unavailable");
        return ESP_FAIL;
    }
    input_client_t *client = calloc(1, sizeof(*client));
    if (client == NULL) {
        network_control_end(pending_usb_generation);
        httpd_resp_set_status(request, "503 Service Unavailable");
        httpd_resp_sendstr(request, "unavailable");
        return ESP_FAIL;
    }
    client->socket = httpd_req_to_sockfd(request);
    client->generation = status.generation;
    client->last_seen = now;
    client->owner = session;
    client->owner_generation = session->generation;
    request->sess_ctx = client;
    request->free_ctx = free_input_client;
    active_client = client;
    return ESP_OK;
}

static esp_err_t input_fault(input_client_t *client)
{
    if (client != NULL && client == active_client) {
        usb_keyboard_release(client->generation);
    }
    return ESP_FAIL;
}

static esp_err_t input_reply(httpd_req_t *request, const char *message)
{
    httpd_ws_frame_t frame = {
        .type = HTTPD_WS_TYPE_TEXT,
        .payload = (uint8_t *)message,
        .len = strlen(message),
    };
    return httpd_ws_send_frame(request, &frame);
}

static void status_json(char *buffer, size_t capacity, usb_keyboard_status_t status)
{
    snprintf(buffer, capacity, "{\"v\":1,\"type\":\"status\",\"usb_ready\":%s,\"caps_lock\":%s}",
             status.ready ? "true" : "false",
             !status.leds_known ? "null" : status.caps_lock ? "true" : "false");
}

static esp_err_t input_handler(httpd_req_t *request)
{
    if (httpd_ws_get_fd_info(request->handle, httpd_req_to_sockfd(request)) != HTTPD_WS_CLIENT_WEBSOCKET) {
        httpd_resp_set_status(request, "426 Upgrade Required");
        return httpd_resp_sendstr(request, "websocket required");
    }
    input_client_t *client = request->sess_ctx;
    int64_t now = esp_timer_get_time();
    usb_keyboard_status_t status = usb_keyboard_status();
    if (client == NULL || client != active_client || client->generation != status.generation ||
        now - client->last_seen >= ACCESS_CONTROL_LEASE_US ||
        !access_session_valid(client->owner, client->owner_generation, now, false)) {
        return input_fault(client);
    }
    httpd_ws_frame_t frame = {0};
    esp_err_t result = httpd_ws_recv_frame(request, &frame, 0);
    if (result != ESP_OK || !input_frame_valid(frame.type == HTTPD_WS_TYPE_TEXT, frame.final, frame.len)) {
        return input_fault(client);
    }
    uint8_t payload[INPUT_MESSAGE_MAX_BYTES];
    frame.payload = payload;
    if (httpd_ws_recv_frame(request, &frame, sizeof(payload)) != ESP_OK) {
        return input_fault(client);
    }
    input_message_t message;
    if (!input_message_parse(payload, frame.len, &message) || message.type == INPUT_STOP) {
        return input_fault(client);
    }
    now = esp_timer_get_time();
    status = usb_keyboard_status();
    if (now - client->last_seen >= ACCESS_CONTROL_LEASE_US || client->generation != status.generation) {
        return input_fault(client);
    }
    client->last_seen = now;
    if (!access_session_valid(client->owner, client->owner_generation, now, true)) return input_fault(client);
    char reply[128];
    if (message.type == INPUT_HEARTBEAT) {
        if (status.ready && !usb_keyboard_heartbeat(client->generation)) {
            return input_fault(client);
        }
        status_json(reply, sizeof(reply), status);
        return input_reply(request, reply);
    }
    if (message.sequence != client->last_sequence + 1 ||
        !usb_keyboard_submit(client->generation, &message.report)) {
        return input_fault(client);
    }
    client->last_sequence = message.sequence;
    if (memcmp(&message.report, &client->last_report, sizeof(message.report)) != 0) {
        client->last_report = message.report;
        power_control_activity();
    }
    snprintf(reply, sizeof(reply), "{\"v\":1,\"type\":\"queued\",\"seq\":%" PRIu32 "}", message.sequence);
    return input_reply(request, reply);
}

static void response_headers(httpd_req_t *request)
{
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(request, "Content-Security-Policy",
                       "default-src 'none'; script-src 'self'; style-src 'self'; "
                       "connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'");
}

static esp_err_t asset_handler(httpd_req_t *request)
{
    if (!request_allowed(request, false)) return ESP_OK;
    const web_asset_t *asset = request->user_ctx;
    response_headers(request);
    httpd_resp_set_type(request, asset->content_type);
    return httpd_resp_send(request, asset->start, asset->end - asset->start - 1);
}

static esp_err_t status_handler(httpd_req_t *request)
{
    if (!request_allowed(request, false) || request_session(request, false) == NULL) return ESP_OK;
    response_headers(request);
    httpd_resp_set_type(request, "application/json");
    char reply[128];
    status_json(reply, sizeof(reply), usb_keyboard_status());
    cJSON *root = cJSON_Parse(reply);
    cJSON *network = network_json();
    if (root == NULL || network == NULL || !cJSON_AddItemToObject(root, "network", network)) {
        cJSON_Delete(root);
        cJSON_Delete(network);
        return problem(request, "503 Service Unavailable", "unavailable");
    }
    cJSON *power = power_json();
    if (power == NULL || !cJSON_AddItemToObject(root, "power", power)) {
        cJSON_Delete(root);
        cJSON_Delete(power);
        return problem(request, "503 Service Unavailable", "unavailable");
    }
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (json == NULL) return problem(request, "503 Service Unavailable", "unavailable");
    esp_err_t result = httpd_resp_sendstr(request, json);
    cJSON_free(json);
    return result;
}

static cJSON *power_json(void)
{
    power_control_status_t power = power_control_status();
    cJSON *result = cJSON_CreateObject();
    if (result == NULL) return NULL;
    bool valid = cJSON_AddBoolToObject(result, "supported", power.supported) &&
        cJSON_AddBoolToObject(result, "available", power.available) &&
        cJSON_AddBoolToObject(result, "preparing", power.preparing) &&
        cJSON_AddNumberToObject(result, "idle_minutes", power.idle_minutes) &&
        cJSON_AddStringToObject(result, "error", power.error);
    if (!valid) { cJSON_Delete(result); return NULL; }
    return result;
}

static esp_err_t power_handler(httpd_req_t *request)
{
    bool mutation = request->method != HTTP_GET;
    if (!request_allowed(request, mutation) || request_session(request, mutation) == NULL) return ESP_OK;
    if (mutation) {
        expire_control(NULL);
        if (active_client != NULL || pending_owner != NULL) return problem(request, "409 Conflict", "release_control_first");
        firmware_update_status_t update = firmware_update_status();
        if (update.busy || update.trial_boot || !update.available || network_operation_busy()) {
            return problem(request, "409 Conflict", "device_busy");
        }
        char type[48];
        if (request->content_len == 0 || request->content_len > 128 ||
            !header(request, "Content-Type", type, sizeof(type)) ||
            (strcmp(type, "application/json") != 0 && strcmp(type, "application/json; charset=utf-8") != 0)) {
            return problem(request, "400 Bad Request", "invalid_power_request");
        }
        uint8_t payload[128];
        size_t received = 0;
        while (received < request->content_len) {
            int count = httpd_req_recv(request, (char *)payload + received, request->content_len - received);
            if (count <= 0) return ESP_FAIL;
            received += (size_t)count;
        }
        uint32_t idle_minutes;
        if (!power_control_parse_request(payload, received, &idle_minutes)) return problem(request, "400 Bad Request", "invalid_power_request");
        esp_err_t result = power_control_configure(idle_minutes);
        if (result != ESP_OK) return problem(request, "503 Service Unavailable", "power_unavailable");
    }
    cJSON *root = power_json();
    char *json = root != NULL ? cJSON_PrintUnformatted(root) : NULL;
    cJSON_Delete(root);
    if (json == NULL) return problem(request, "503 Service Unavailable", "unavailable");
    response_headers(request);
    httpd_resp_set_type(request, "application/json");
    esp_err_t result = httpd_resp_sendstr(request, json);
    cJSON_free(json);
    return result;
}

static cJSON *network_json(void)
{
    network_status_t network;
    network_status(&network);
    cJSON *result = cJSON_CreateObject();
    if (result == NULL) return NULL;
    bool valid = cJSON_AddBoolToObject(result, "available", network.available) &&
        cJSON_AddBoolToObject(result, "ap_active", network.ap_active) &&
        cJSON_AddBoolToObject(result, "station_online", network.station_online) &&
        cJSON_AddBoolToObject(result, "desired_station", network.desired_station) &&
        cJSON_AddBoolToObject(result, "has_profile", network.has_profile) &&
        cJSON_AddBoolToObject(result, "busy", network.busy) &&
        cJSON_AddBoolToObject(result, "mdns", network.mdns) &&
        cJSON_AddBoolToObject(result, "can_control", network.can_control) &&
        cJSON_AddNumberToObject(result, "job_id", network.job_id) &&
        cJSON_AddStringToObject(result, "phase", network.phase) &&
        cJSON_AddStringToObject(result, "job", network.job) &&
        cJSON_AddStringToObject(result, "error", network.error) &&
        cJSON_AddStringToObject(result, "hostname", network.hostname) &&
        cJSON_AddStringToObject(result, "requested_hostname", network.requested_hostname) &&
        cJSON_AddStringToObject(result, "ap_ssid", network.ap_ssid) &&
        cJSON_AddStringToObject(result, "saved_ssid", network.saved_ssid) &&
        cJSON_AddStringToObject(result, "saved_ssid_hex", network.saved_ssid_hex) &&
        cJSON_AddStringToObject(result, "station_ssid", network.station_ssid) &&
        cJSON_AddStringToObject(result, "ap_ip", network.ap_ip) &&
        cJSON_AddStringToObject(result, "ap_reconnect_ip", network.ap_reconnect_ip) &&
        cJSON_AddStringToObject(result, "station_ip", network.station_ip);
    cJSON *scan = valid ? cJSON_AddArrayToObject(result, "scan") : NULL;
    valid = scan != NULL;
    for (size_t index = 0; valid && index < network.scan_count; index++) {
        cJSON *item = cJSON_CreateObject();
        if (item == NULL) { valid = false; break; }
        valid = cJSON_AddStringToObject(item, "ssid", network.scan[index].ssid) &&
            cJSON_AddStringToObject(item, "ssid_hex", network.scan[index].ssid_hex) &&
                cJSON_AddNumberToObject(item, "rssi", network.scan[index].rssi) &&
                cJSON_AddBoolToObject(item, "supported", network.scan[index].supported);
        if (!valid || !cJSON_AddItemToArray(scan, item)) { cJSON_Delete(item); valid = false; }
    }
    if (!valid) { cJSON_Delete(result); return NULL; }
    return result;
}

static esp_err_t network_handler(httpd_req_t *request)
{
    if (!request_allowed(request, request->method != HTTP_GET) ||
        request_session(request, request->method != HTTP_GET) == NULL) return ESP_OK;
    if (request->method == HTTP_GET) {
        cJSON *root = network_json();
        char *json = root != NULL ? cJSON_PrintUnformatted(root) : NULL;
        cJSON_Delete(root);
        if (json == NULL) return problem(request, "503 Service Unavailable", "unavailable");
        response_headers(request);
        httpd_resp_set_type(request, "application/json");
        esp_err_t result = httpd_resp_sendstr(request, json);
        cJSON_free(json);
        return result;
    }
    expire_control(NULL);
    if (firmware_update_status().busy) return problem(request, "409 Conflict", "update_busy");
    if (active_client != NULL || pending_owner != NULL) return problem(request, "409 Conflict", "release_control_first");
    bool scan = strcmp(request->uri, "/api/v1/network/scan") == 0;
    char type[64];
    if (request->content_len > 1024 || (scan && request->content_len != 0)) return problem(request, "413 Content Too Large", "invalid_network_request");
    if (!scan && (request->content_len == 0 || !header(request, "Content-Type", type, sizeof(type)) ||
        (strcmp(type, "application/json") != 0 && strcmp(type, "application/json; charset=utf-8") != 0))) return problem(request, "400 Bad Request", "invalid_network_request");
    uint8_t payload[1024];
    size_t length = 0;
    while (length < request->content_len) {
        int count = httpd_req_recv(request, (char *)payload + length, request->content_len - length);
        if (count <= 0) {
            mbedtls_platform_zeroize(payload, sizeof(payload));
            return ESP_FAIL;
        }
        length += count;
    }
    uint32_t job_id;
    esp_err_t result = network_submit(payload, length, scan, &job_id);
    mbedtls_platform_zeroize(payload, sizeof(payload));
    if (result == ESP_ERR_INVALID_ARG) return problem(request, "400 Bad Request", "invalid_network_request");
    if (result == ESP_FAIL) return problem(request, "503 Service Unavailable", "storage_failed");
    if (result != ESP_OK) return problem(request, "409 Conflict", "network_busy");
    power_control_activity();
    response_headers(request);
    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    esp_ip4_addr_t address = {.addr = local_address(request)};
    char management_url[32] = "";
    if (address.addr != 0) snprintf(management_url, sizeof(management_url), "http://" IPSTR "/", IP2STR(&address));
    char reply[128];
    snprintf(reply, sizeof(reply), "{\"job_id\":%" PRIu32 ",\"management_url\":\"%s\"}", job_id, management_url);
    return httpd_resp_sendstr(request, reply);
}

static void random_token(char token[ACCESS_TOKEN_LENGTH + 1])
{
    uint8_t bytes[ACCESS_TOKEN_LENGTH / 2];
    static const char hex[] = "0123456789abcdef";
    esp_fill_random(bytes, sizeof(bytes));
    for (size_t index = 0; index < sizeof(bytes); index++) {
        token[index * 2] = hex[bytes[index] >> 4];
        token[index * 2 + 1] = hex[bytes[index] & 15];
    }
    token[ACCESS_TOKEN_LENGTH] = '\0';
    mbedtls_platform_zeroize(bytes, sizeof(bytes));
}

static esp_err_t update_reply(httpd_req_t *request, bool job, uint32_t expected_job)
{
    firmware_update_status_t update = firmware_update_status();
    if (expected_job != 0 && expected_job != update.policy.job_id) return problem(request, "409 Conflict", "update_not_ready");
    const update_descriptor_t *running = firmware_update_descriptor();
    const char *phases[] = {"idle", "receiving", "verifying", "staged", "activating", "failed", "cancelled"};
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return problem(request, "503 Service Unavailable", "unavailable");
    bool valid = cJSON_AddStringToObject(root, "version", running->version) &&
        cJSON_AddStringToObject(root, "board", running->board) && cJSON_AddStringToObject(root, "layout", running->layout) &&
        cJSON_AddStringToObject(root, "source", running->source) && cJSON_AddBoolToObject(root, "test_only", running->security_profile == 1) &&
        cJSON_AddBoolToObject(root, "available", update.available) && cJSON_AddBoolToObject(root, "busy", update.busy) &&
        cJSON_AddBoolToObject(root, "trial_boot", update.trial_boot) && cJSON_AddNumberToObject(root, "max_bytes", UPDATE_IMAGE_LIMIT);
    if (job) valid = valid && cJSON_AddNumberToObject(root, "job_id", update.policy.job_id) &&
        cJSON_AddStringToObject(root, "phase", phases[update.policy.phase]) &&
        cJSON_AddNumberToObject(root, "received", update.policy.received) && cJSON_AddNumberToObject(root, "expected", update.policy.expected) &&
        cJSON_AddStringToObject(root, "candidate_version", update.candidate_version) &&
        cJSON_AddStringToObject(root, "sha256", update.digest) && cJSON_AddStringToObject(root, "error", update.error);
    char *json = valid ? cJSON_PrintUnformatted(root) : NULL;
    cJSON_Delete(root);
    if (json == NULL) return problem(request, "503 Service Unavailable", "unavailable");
    response_headers(request);
    httpd_resp_set_type(request, "application/json");
    esp_err_t result = httpd_resp_sendstr(request, json);
    cJSON_free(json);
    return result;
}

static bool update_owned(httpd_req_t *request, access_session_t *session)
{
    return session == update_owner && session->generation == update_owner_generation &&
        local_address(request) == update_owner_address;
}

typedef struct {
    httpd_req_t *request;
    uint32_t job_id;
    uint8_t buffer[4096];
} update_upload_t;

static void update_upload_worker(void *argument)
{
    update_upload_t *upload = argument;
    esp_err_t result = firmware_update_open(upload->job_id);
    size_t received = 0;
    while (result == ESP_OK && received < upload->request->content_len) {
        firmware_update_status_t current = firmware_update_status();
        if (current.policy.job_id != upload->job_id || current.policy.phase != UPDATE_RECEIVING ||
            update_policy_expired(&current.policy, esp_timer_get_time())) {
            result = ESP_ERR_TIMEOUT;
            break;
        }
        size_t count = upload->request->content_len - received;
        if (count > sizeof(upload->buffer)) count = sizeof(upload->buffer);
        int length = httpd_req_recv(upload->request, (char *)upload->buffer, count);
        if (length == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (length <= 0) { result = ESP_FAIL; break; }
        result = firmware_update_write(upload->job_id, upload->buffer, (size_t)length);
        received += (size_t)length;
    }
    if (result == ESP_OK) result = firmware_update_finish(upload->job_id);
    if (result != ESP_OK) firmware_update_fail(upload->job_id, result == ESP_ERR_TIMEOUT ? "update_timeout" : "invalid_or_incomplete_image");
    firmware_update_worker_done(upload->job_id);
    if (result == ESP_OK) {
        update_reply(upload->request, true, upload->job_id);
    } else {
        httpd_resp_set_hdr(upload->request, "Connection", "close");
        problem(upload->request, "400 Bad Request", "update_failed");
        httpd_sess_trigger_close(server, httpd_req_to_sockfd(upload->request));
    }
    httpd_req_async_handler_complete(upload->request);
    free(upload);
    vTaskDelete(NULL);
}

static esp_err_t update_upload_handler(httpd_req_t *request)
{
    if (!request_allowed(request, true)) return ESP_FAIL;
    access_session_t *session = request_session(request, true);
    if (session == NULL) return ESP_FAIL;
    expire_control(NULL);
    if (active_client != NULL || pending_owner != NULL) {
        problem(request, "409 Conflict", "release_control_first");
        return ESP_FAIL;
    }
    char type[48];
    if (!update_image_size_valid(request->content_len) || httpd_req_get_hdr_value_len(request, "Transfer-Encoding") != 0 ||
        !header(request, "Content-Type", type, sizeof(type)) || strcmp(type, "application/octet-stream") != 0) {
        problem(request, "400 Bad Request", "invalid_update_request");
        return ESP_FAIL;
    }
    update_upload_t *upload = calloc(1, sizeof(*upload));
    if (upload == NULL) return problem(request, "503 Service Unavailable", "unavailable");
    esp_err_t result = firmware_update_reserve(request->content_len, local_address(request), &upload->job_id);
    if (result != ESP_OK) {
        free(upload);
        problem(request, "409 Conflict", "update_unavailable_or_busy");
        return ESP_FAIL;
    }
    update_owner = session;
    power_control_activity();
    update_owner_generation = session->generation;
    update_owner_address = local_address(request);
    result = httpd_req_async_handler_begin(request, &upload->request);
    if (result == ESP_OK && xTaskCreate(update_upload_worker, "ota_upload", 12288, upload, 2, NULL) == pdPASS) return ESP_OK;
    firmware_update_fail(upload->job_id, "unavailable");
    firmware_update_worker_done(upload->job_id);
    httpd_req_t *reply = upload->request != NULL ? upload->request : request;
    problem(reply, "503 Service Unavailable", "unavailable");
    if (upload->request != NULL) httpd_req_async_handler_complete(upload->request);
    free(upload);
    return ESP_FAIL;
}

static bool update_command(httpd_req_t *request, bool activation, uint32_t *job_id, char digest[65])
{
    char type[48];
    if (request->content_len == 0 || request->content_len > 192 || !header(request, "Content-Type", type, sizeof(type)) ||
        strcmp(type, "application/json") != 0) return false;
    char payload[193];
    size_t received = 0;
    while (received < request->content_len) {
        int count = httpd_req_recv(request, payload + received, request->content_len - received);
        if (count <= 0) return false;
        received += (size_t)count;
    }
    if (memchr(payload, '\0', received) != NULL) return false;
    payload[received] = '\0';
    cJSON *root = cJSON_ParseWithLengthOpts(payload, received + 1, NULL, true);
    cJSON *id = cJSON_GetObjectItemCaseSensitive(root, "job_id");
    cJSON *hash_value = cJSON_GetObjectItemCaseSensitive(root, "sha256");
    bool valid = cJSON_IsObject(root) && cJSON_GetArraySize(root) == (activation ? 2 : 1) && cJSON_IsNumber(id) &&
        id->valuedouble >= 1 && id->valuedouble <= UINT32_MAX && id->valuedouble == (uint32_t)id->valuedouble;
    if (activation) valid = valid && cJSON_IsString(hash_value) && strlen(hash_value->valuestring) == 64;
    if (valid) {
        *job_id = (uint32_t)id->valuedouble;
        if (activation) memcpy(digest, hash_value->valuestring, 65);
    }
    cJSON_Delete(root);
    return valid;
}

static esp_err_t update_management_handler(httpd_req_t *request)
{
    bool mutation = request->method != HTTP_GET;
    if (!request_allowed(request, mutation)) return ESP_OK;
    access_session_t *session = request_session(request, mutation);
    if (session == NULL) return ESP_OK;
    firmware_update_tick();
    bool firmware = strcmp(request->uri, "/api/v1/firmware") == 0;
    if (firmware) return update_reply(request, false, 0);
    if (firmware_update_status().busy && !update_owned(request, session)) {
        return problem(request, "403 Forbidden", "update_owner_required");
    }
    if (!mutation) return update_reply(request, true, 0);
    bool activation = request->method == HTTP_POST;
    uint32_t job_id = 0;
    char digest[65] = {0};
    if (!update_command(request, activation, &job_id, digest)) return problem(request, "400 Bad Request", "invalid_update_request");
    bool accepted = activation ? firmware_update_activate(job_id, digest) == ESP_OK : firmware_update_cancel(job_id);
    if (!accepted) return problem(request, "409 Conflict", "update_not_ready");
    power_control_activity();
    httpd_resp_set_status(request, "202 Accepted");
    esp_err_t result = update_reply(request, true, job_id);
    if (activation) firmware_update_restart();
    return result;
}

static esp_err_t session_reply(httpd_req_t *request, access_session_t *session)
{
    response_headers(request);
    httpd_resp_set_type(request, "application/json");
    char response[256];
    snprintf(response, sizeof(response), "{\"provisioned\":%s,\"claimed\":%s,\"authenticated\":%s,\"csrf\":\"%s\"}",
             device_identity_ready() ? "true" : "false", device_identity_claimed() ? "true" : "false",
             session != NULL ? "true" : "false", session != NULL ? session->csrf : "");
    return httpd_resp_sendstr(request, response);
}

static esp_err_t issue_session(httpd_req_t *request)
{
    char token[ACCESS_TOKEN_LENGTH + 1];
    char csrf[ACCESS_TOKEN_LENGTH + 1];
    random_token(token);
    random_token(csrf);
    access_session_t *session = access_session_create(&access_control, token, csrf, esp_timer_get_time());
    if (session == NULL) return problem(request, "503 Service Unavailable", "session_capacity");
    power_control_activity();
    char cookie[192];
    snprintf(cookie, sizeof(cookie), "kb_session=%s; Path=/; HttpOnly; SameSite=Strict", token);
    httpd_resp_set_hdr(request, "Set-Cookie", cookie);
    return session_reply(request, session);
}

static bool read_credentials(httpd_req_t *request, bool claim, access_credentials_t *credentials)
{
    char content_type[64];
    if (request->content_len == 0 || request->content_len > ACCESS_CREDENTIAL_BODY_MAX ||
        !header(request, "Content-Type", content_type, sizeof(content_type)) ||
        (strcmp(content_type, "application/json") != 0 && strcmp(content_type, "application/json; charset=utf-8") != 0)) return false;
    uint8_t payload[ACCESS_CREDENTIAL_BODY_MAX];
    size_t received = 0;
    while (received < request->content_len) {
        int count = httpd_req_recv(request, (char *)payload + received, request->content_len - received);
        if (count <= 0) {
            mbedtls_platform_zeroize(payload, sizeof(payload));
            return false;
        }
        received += count;
    }
    bool valid = access_credentials_parse(payload, received, claim, credentials);
    mbedtls_platform_zeroize(payload, sizeof(payload));
    return valid;
}

static esp_err_t session_handler(httpd_req_t *request)
{
    if (!request_allowed(request, request->method != HTTP_GET)) return ESP_OK;
    expire_control(NULL);
    if (request->method == HTTP_GET) {
        char cookie[513];
        access_session_t *session = header(request, "Cookie", cookie, sizeof(cookie)) ?
            access_session_find(&access_control, cookie, esp_timer_get_time()) : NULL;
        return session_reply(request, session);
    }
    if (request->method == HTTP_DELETE) {
        access_session_t *session = request_session(request, true);
        if (session == NULL) return ESP_OK;
        if ((active_client != NULL && active_client->owner == session) || pending_owner == session) release_control();
        if (update_owner == session && update_owner_generation == session->generation) firmware_update_cancel(firmware_update_status().policy.job_id);
        access_session_revoke(session);
        power_control_activity();
        httpd_resp_set_hdr(request, "Set-Cookie", "kb_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
        return session_reply(request, NULL);
    }
    if (!device_identity_ready()) return problem(request, "503 Service Unavailable", "provisioning_required");
    if (!device_identity_claimed()) return problem(request, "409 Conflict", "claim_required");
    if (!access_login_attempt(&access_control, esp_timer_get_time())) return problem(request, "429 Too Many Requests", "login_rate_limited");
    access_credentials_t credentials;
    if (!read_credentials(request, false, &credentials)) return problem(request, "400 Bad Request", "invalid_credentials");
    bool valid = device_identity_verify(credentials.password);
    mbedtls_platform_zeroize(&credentials, sizeof(credentials));
    return valid ? issue_session(request) : problem(request, "401 Unauthorized", "invalid_credentials");
}

static esp_err_t claim_handler(httpd_req_t *request)
{
    if (!request_allowed(request, true)) return ESP_OK;
    if (!device_identity_ready()) return problem(request, "503 Service Unavailable", "provisioning_required");
    if (device_identity_claimed()) return problem(request, "409 Conflict", "already_claimed");
    if (!access_login_attempt(&access_control, esp_timer_get_time())) return problem(request, "429 Too Many Requests", "login_rate_limited");
    access_credentials_t credentials;
    if (!read_credentials(request, true, &credentials)) return problem(request, "400 Bad Request", "invalid_credentials");
    esp_err_t result = device_identity_claim(credentials.setup_code, credentials.password);
    mbedtls_platform_zeroize(&credentials, sizeof(credentials));
    if (result == ESP_ERR_INVALID_CRC) return problem(request, "401 Unauthorized", "invalid_setup_code");
    if (result != ESP_OK) return problem(request, "503 Service Unavailable", "claim_failed");
    return issue_session(request);
}

static esp_err_t control_handler(httpd_req_t *request)
{
    if (!request_allowed(request, true)) return ESP_OK;
    access_session_t *session = request_session(request, true);
    if (session == NULL) return ESP_OK;
    expire_control(NULL);
    if (strcmp(request->uri, "/api/v1/control/stop") == 0) {
        release_control();
    } else {
        if (firmware_update_status().busy) return problem(request, "409 Conflict", "update_busy");
        if (!firmware_update_status().available) return problem(request, "503 Service Unavailable", "device_starting");
        if (active_client != NULL || pending_owner != NULL) return problem(request, "409 Conflict", "busy");
        if (!usb_keyboard_status().ready) return problem(request, "503 Service Unavailable", "usb_unavailable");
        uint32_t generation = usb_keyboard_status().generation;
        if (!network_control_begin(local_address(request), generation)) return problem(request, "409 Conflict", "network_busy");
        pending_owner = session;
        pending_generation = session->generation;
        pending_usb_generation = generation;
        pending_until = esp_timer_get_time() + INT64_C(5000000);
    }
    power_control_activity();
    response_headers(request);
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(request, "{\"ok\":true}");
}

esp_err_t web_server_start(void)
{
#if !CONFIG_KEYBOARD_HTTP_DEVELOPMENT
    return ESP_ERR_NOT_SUPPORTED;
#endif
    if (!device_identity_ready()) return ESP_ERR_INVALID_STATE;
    power_control_init();
    httpd_config_t configuration = HTTPD_DEFAULT_CONFIG();
    configuration.max_uri_handlers = sizeof(assets) / sizeof(assets[0]) + 18;
    configuration.max_open_sockets = 7;
    configuration.stack_size = 8192;
    configuration.recv_wait_timeout = 2;
    configuration.send_wait_timeout = 2;
    esp_err_t result = httpd_start(&server, &configuration);
    if (result != ESP_OK) {
        return result;
    }
    for (size_t index = 0; index < sizeof(assets) / sizeof(assets[0]); index++) {
        httpd_uri_t route = {
            .uri = assets[index].uri,
            .method = HTTP_GET,
            .handler = asset_handler,
            .user_ctx = (void *)&assets[index],
        };
        result = httpd_register_uri_handler(server, &route);
        if (result != ESP_OK) {
            httpd_stop(server);
            return result;
        }
    }
    httpd_uri_t status_route = {
        .uri = "/api/v1/status",
        .method = HTTP_GET,
        .handler = status_handler,
    };
    result = httpd_register_uri_handler(server, &status_route);
    if (result != ESP_OK) {
        httpd_stop(server);
        return result;
    }
    const httpd_uri_t management_routes[] = {
        {.uri = "/api/v1/session", .method = HTTP_GET, .handler = session_handler},
        {.uri = "/api/v1/session", .method = HTTP_POST, .handler = session_handler},
        {.uri = "/api/v1/session", .method = HTTP_DELETE, .handler = session_handler},
        {.uri = "/api/v1/claim", .method = HTTP_POST, .handler = claim_handler},
        {.uri = "/api/v1/control/take", .method = HTTP_POST, .handler = control_handler},
        {.uri = "/api/v1/control/stop", .method = HTTP_POST, .handler = control_handler},
        {.uri = "/api/v1/network", .method = HTTP_POST, .handler = network_handler},
        {.uri = "/api/v1/network/scan", .method = HTTP_POST, .handler = network_handler},
        {.uri = "/api/v1/network/job", .method = HTTP_GET, .handler = network_handler},
        {.uri = "/api/v1/power", .method = HTTP_GET, .handler = power_handler},
        {.uri = "/api/v1/power", .method = HTTP_POST, .handler = power_handler},
        {.uri = "/api/v1/firmware", .method = HTTP_GET, .handler = update_management_handler},
        {.uri = "/api/v1/update", .method = HTTP_POST, .handler = update_upload_handler},
        {.uri = "/api/v1/update/job", .method = HTTP_GET, .handler = update_management_handler},
        {.uri = "/api/v1/update/job", .method = HTTP_DELETE, .handler = update_management_handler},
        {.uri = "/api/v1/update/activate", .method = HTTP_POST, .handler = update_management_handler},
    };
    for (size_t index = 0; index < sizeof(management_routes) / sizeof(management_routes[0]); index++) {
        result = httpd_register_uri_handler(server, &management_routes[index]);
        if (result != ESP_OK) {
            httpd_stop(server);
            return result;
        }
    }
    httpd_uri_t input_route = {
        .uri = "/api/v1/keyboard",
        .method = HTTP_GET,
        .handler = input_handler,
        .is_websocket = true,
        .ws_pre_handshake_cb = input_handshake,
    };
    result = httpd_register_uri_handler(server, &input_route);
    if (result != ESP_OK) {
        httpd_stop(server);
        return result;
    }
    const esp_timer_create_args_t timer = {.callback = control_tick, .name = "control_expiry"};
    result = esp_timer_create(&timer, &control_timer);
    if (result == ESP_OK) result = esp_timer_start_periodic(control_timer, 250000);
    if (result != ESP_OK) {
        if (control_timer != NULL) {
            esp_timer_delete(control_timer);
            control_timer = NULL;
        }
        httpd_stop(server);
        server = NULL;
    }
    server_started = result == ESP_OK;
    return result;
}