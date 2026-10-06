#include "idf_stubs.h"
#include "access_control.h"
#include "firmware_update.h"
#include "usb_keyboard.h"
#include "web_server.h"
#include "cJSON.h"

#include <assert.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ESP_ERR_NOT_FOUND 7
typedef struct { const char *uri; int socket; bool close_header; const char *control_id; } httpd_req_t;
typedef struct {
    int socket;
    uint32_t generation;
    int64_t last_seen;
    access_session_t *owner;
    uint32_t owner_generation;
    uint32_t control_id;
} input_client_t;
static input_client_t *active_client;
static access_session_t *pending_owner;
static uint32_t pending_generation;
static uint32_t pending_usb_generation;
static int64_t pending_until;
static uint32_t pending_control_id;
static uint32_t next_control_id;
static access_session_t *update_owner;
static uint32_t update_owner_generation;
static uint32_t update_owner_address;
static httpd_handle_t server;
static int64_t now = 1000;
static access_session_t owner = { .generation = 1 };
static access_session_t *request_owner = &owner;
static usb_keyboard_status_t usb = { .ready = true, .generation = 7 };
static unsigned network_ends;
static unsigned usb_releases;
static unsigned closed_sockets;
static unsigned network_begins;
static unsigned capacity_logs;
static size_t socket_count = WEB_SERVER_MAX_OPEN_SOCKETS - 1;
static esp_err_t capacity_result = ESP_OK;
static esp_err_t close_result = ESP_OK;
static esp_err_t header_result = ESP_OK;
static unsigned own_close_requests;
static int response_status;
static const char *response_error;

int64_t esp_timer_get_time(void) { return now; }
usb_keyboard_status_t usb_keyboard_status(void) { return usb; }
void usb_keyboard_release(uint32_t generation) { assert(generation == usb.generation); usb_releases++; }
void network_control_end(uint32_t generation) { assert(generation == usb.generation); network_ends++; }
static bool network_control_begin(uint32_t address, uint32_t generation)
{
    assert(address == 42 && generation == usb.generation);
    network_begins++;
    return true;
}
static esp_err_t httpd_get_client_list(httpd_handle_t handle, size_t *count, int *sockets)
{
    assert(handle == server && *count == WEB_SERVER_MAX_OPEN_SOCKETS);
    for (size_t index = 0; index < *count; index++) sockets[index] = (int)index + 10;
    *count = socket_count;
    return capacity_result;
}
const char *esp_err_to_name(esp_err_t result) { assert(result == ESP_FAIL); return "ESP_FAIL"; }
void test_log(const char *tag, const char *format, ...)
{
    assert(strcmp(tag, "web_control") == 0 &&
           (strstr(format, "Connection capacity check failed") != NULL ||
            strstr(format, "Control response close header failed") != NULL ||
            strstr(format, "Control HTTP connection close could not be queued") != NULL));
    capacity_logs++;
}
esp_err_t httpd_sess_trigger_close(httpd_handle_t handle, int socket)
{
    assert(handle == server);
    if (socket == 10) {
        own_close_requests++;
        return close_result;
    }
    assert(socket == 5);
    closed_sockets++;
    return ESP_OK;
}
void firmware_update_tick(void) {}
firmware_update_status_t firmware_update_status(void)
{
    return (firmware_update_status_t){ .available = true };
}
bool firmware_update_cancel(uint32_t job_id) { (void)job_id; assert(false); return false; }
static bool request_allowed(httpd_req_t *request, bool mutation)
{
    (void)request;
    assert(mutation);
    return true;
}
static access_session_t *request_session(httpd_req_t *request, bool mutation)
{
    (void)request;
    assert(mutation);
    return request_owner;
}
static uint32_t local_address(httpd_req_t *request) { (void)request; return 42; }
static int httpd_req_to_sockfd(httpd_req_t *request) { return request->socket; }
static esp_err_t httpd_req_get_hdr_value_str(httpd_req_t *request, const char *name, char *value, size_t capacity)
{
    assert(strcmp(name, "X-Control-Id") == 0);
    if (request->control_id == NULL) return ESP_ERR_NOT_FOUND;
    if (strlen(request->control_id) >= capacity) return ESP_FAIL;
    strcpy(value, request->control_id);
    return ESP_OK;
}
static esp_err_t httpd_resp_set_hdr(httpd_req_t *request, const char *name, const char *value)
{
    assert(strcmp(name, "Connection") == 0 && strcmp(value, "close") == 0);
    if (header_result == ESP_OK) request->close_header = true;
    return header_result;
}
static void power_control_activity(void) {}
static void response_headers(httpd_req_t *request) { (void)request; response_status = 200; }
static void httpd_resp_set_type(httpd_req_t *request, const char *type)
{
    (void)request;
    assert(strcmp(type, "application/json") == 0);
}
static esp_err_t httpd_resp_sendstr(httpd_req_t *request, const char *body)
{
    cJSON *reply = cJSON_Parse(body);
    assert(reply != NULL && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(reply, "ok")));
    cJSON *id = cJSON_GetObjectItemCaseSensitive(reply, "control_id");
    if (strcmp(request->uri, "/api/v1/control/take") == 0) {
        assert(cJSON_IsNumber(id) && id->valuedouble == pending_control_id && pending_control_id != 0);
    } else assert(id == NULL);
    cJSON_Delete(reply);
    return ESP_OK;
}
static esp_err_t problem(httpd_req_t *request, const char *status, const char *code)
{
    (void)request;
    assert(strcmp(status, "409 Conflict") == 0 || strcmp(status, "503 Service Unavailable") == 0 ||
           strcmp(status, "400 Bad Request") == 0);
    response_status = atoi(status);
    response_error = code;
    return ESP_OK;
}

#include "control_expiry.inc"
#include "control_http.inc"

int main(void)
{
    httpd_req_t take = { .uri = "/api/v1/control/take", .socket = 10 };
    httpd_req_t stop = { .uri = "/api/v1/control/stop", .socket = 10 };
    socket_count = WEB_SERVER_MAX_OPEN_SOCKETS;
    close_result = ESP_FAIL;
    assert(control_handler(&take) == ESP_OK && response_status == 503);
    assert(strcmp(response_error, "connection_capacity_exhausted") == 0);
    assert(pending_owner == NULL && network_begins == 0);
    assert(take.close_header && own_close_requests == 1 && capacity_logs == 1);
    close_result = ESP_OK;
    take.close_header = false;
    header_result = ESP_FAIL;
    assert(control_handler(&take) == ESP_OK && response_status == 503);
    assert(strcmp(response_error, "connection_capacity_unavailable") == 0 && capacity_logs == 2);
    assert(!take.close_header && own_close_requests == 1 && pending_owner == NULL && network_begins == 0);
    header_result = ESP_OK;
    assert(control_handler(&take) == ESP_OK && response_status == 200);
    assert(take.close_header && own_close_requests == 2 && pending_owner == &owner && network_begins == 1);
    assert(owner.generation == 1);
    assert(control_handler(&stop) == ESP_OK && response_status == 200);
    assert(pending_owner == NULL && network_ends == 1 && !stop.close_header);
    capacity_result = ESP_FAIL;
    socket_count = WEB_SERVER_MAX_OPEN_SOCKETS - 1;
    assert(control_handler(&take) == ESP_OK && response_status == 503);
    assert(strcmp(response_error, "connection_capacity_unavailable") == 0 && capacity_logs == 3);
    assert(pending_owner == NULL && network_begins == 1 && own_close_requests == 2);
    capacity_result = ESP_OK;
    assert(WEB_SERVER_MAX_OPEN_SOCKETS == 7);
    take.close_header = false;
    assert(control_handler(&take) == ESP_OK && response_status == 200);
    assert(!take.close_header && own_close_requests == 2);
    assert(pending_owner == &owner && pending_generation == owner.generation);
    assert(pending_usb_generation == usb.generation && pending_until - now == INT64_C(10000000));
    int64_t deadline = pending_until;
    now += INT64_C(6000000);
    expire_control(NULL);
    assert(pending_owner == &owner && network_ends == 1);
    assert(control_handler(&take) == ESP_OK && response_status == 409 && strcmp(response_error, "busy") == 0);
    assert(pending_until == deadline);
    now = deadline - 1;
    expire_control(NULL);
    assert(pending_owner == &owner);
    now = deadline;
    expire_control(NULL);
    assert(pending_owner == NULL && network_ends == 2);
    assert(control_handler(&take) == ESP_OK && response_status == 200);
    assert(control_handler(&stop) == ESP_OK && pending_owner == NULL && network_ends == 3);

    assert(control_handler(&take) == ESP_OK && response_status == 200);
    uint32_t old_id = pending_control_id;
    char text[11];
    snprintf(text, sizeof(text), "%" PRIu32, old_id);
    stop.control_id = text;
    assert(control_handler(&stop) == ESP_OK && response_status == 200 && pending_owner == NULL);
    assert(control_handler(&take) == ESP_OK && pending_control_id != old_id);
    unsigned ends_before = network_ends;
    assert(control_handler(&stop) == ESP_OK && response_status == 409 &&
           strcmp(response_error, "control_request_stale") == 0 && pending_owner == &owner && network_ends == ends_before);
    access_session_t other = { .generation = 2 };
    request_owner = &other;
    snprintf(text, sizeof(text), "%" PRIu32, pending_control_id);
    assert(control_handler(&stop) == ESP_OK && response_status == 409 && pending_owner == &owner);
    request_owner = &owner;
    const char *invalid_ids[] = {"", "0", "01", "-1", "1x", "4294967296", "99999999999"};
    for (size_t index = 0; index < sizeof(invalid_ids) / sizeof(invalid_ids[0]); index++) {
        stop.control_id = invalid_ids[index];
        assert(control_handler(&stop) == ESP_OK && response_status == 400 &&
               strcmp(response_error, "invalid_control_request") == 0 && pending_owner == &owner);
    }
    stop.control_id = NULL;
    assert(control_handler(&stop) == ESP_OK && pending_owner == NULL);
    input_client_t client = { .socket = 5, .generation = usb.generation, .last_seen = now,
        .owner = &owner, .owner_generation = owner.generation, .control_id = pending_control_id };
    active_client = &client;
    snprintf(text, sizeof(text), "%" PRIu32, old_id);
    stop.control_id = text;
    assert(control_handler(&stop) == ESP_OK && response_status == 409 && active_client == &client && usb_releases == 0);
    now += INT64_C(999999);
    expire_control(NULL);
    assert(active_client == &client && usb_releases == 0);
    now++;
    expire_control(NULL);
    assert(active_client == NULL && usb_releases == 1 && closed_sockets == 1);
    puts("PASS: real control handler reserves 10s, expires at boundary, stops explicitly and preserves 1s active lease");
}
