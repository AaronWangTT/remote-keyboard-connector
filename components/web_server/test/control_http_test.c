#include "idf_stubs.h"
#include "access_control.h"
#include "firmware_update.h"
#include "usb_keyboard.h"
#include "web_server.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct { const char *uri; } httpd_req_t;
typedef struct {
    int socket;
    uint32_t generation;
    int64_t last_seen;
    access_session_t *owner;
    uint32_t owner_generation;
} input_client_t;
static input_client_t *active_client;
static access_session_t *pending_owner;
static uint32_t pending_generation;
static uint32_t pending_usb_generation;
static int64_t pending_until;
static access_session_t *update_owner;
static uint32_t update_owner_generation;
static uint32_t update_owner_address;
static httpd_handle_t server;
static int64_t now = 1000;
static access_session_t owner = { .generation = 1 };
static usb_keyboard_status_t usb = { .ready = true, .generation = 7 };
static unsigned network_ends;
static unsigned usb_releases;
static unsigned closed_sockets;
static unsigned network_begins;
static unsigned capacity_logs;
static size_t socket_count = WEB_SERVER_MAX_OPEN_SOCKETS - 1;
static esp_err_t capacity_result = ESP_OK;
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
    assert(strcmp(tag, "web_control") == 0 && strstr(format, "Connection capacity check failed") != NULL);
    capacity_logs++;
}
esp_err_t httpd_sess_trigger_close(httpd_handle_t handle, int socket)
{
    assert(handle == server && socket == 5);
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
    return &owner;
}
static uint32_t local_address(httpd_req_t *request) { (void)request; return 42; }
static void power_control_activity(void) {}
static void response_headers(httpd_req_t *request) { (void)request; response_status = 200; }
static void httpd_resp_set_type(httpd_req_t *request, const char *type)
{
    (void)request;
    assert(strcmp(type, "application/json") == 0);
}
static esp_err_t httpd_resp_sendstr(httpd_req_t *request, const char *body)
{
    (void)request;
    assert(strcmp(body, "{\"ok\":true}") == 0);
    return ESP_OK;
}
static esp_err_t problem(httpd_req_t *request, const char *status, const char *code)
{
    (void)request;
    assert(strcmp(status, "409 Conflict") == 0 || strcmp(status, "503 Service Unavailable") == 0);
    response_status = strcmp(status, "409 Conflict") == 0 ? 409 : 503;
    response_error = code;
    return ESP_OK;
}

#include "control_expiry.inc"
#include "control_http.inc"

int main(void)
{
    httpd_req_t take = { .uri = "/api/v1/control/take" };
    httpd_req_t stop = { .uri = "/api/v1/control/stop" };
    socket_count = WEB_SERVER_MAX_OPEN_SOCKETS;
    assert(control_handler(&take) == ESP_OK && response_status == 503);
    assert(strcmp(response_error, "connection_capacity_exhausted") == 0);
    assert(pending_owner == NULL && network_begins == 0);
    assert(control_handler(&stop) == ESP_OK && response_status == 200);
    assert(pending_owner == NULL && network_ends == 0);
    capacity_result = ESP_FAIL;
    socket_count = WEB_SERVER_MAX_OPEN_SOCKETS - 1;
    assert(control_handler(&take) == ESP_OK && response_status == 503);
    assert(strcmp(response_error, "connection_capacity_unavailable") == 0 && capacity_logs == 1);
    assert(pending_owner == NULL && network_begins == 0);
    capacity_result = ESP_OK;
    assert(WEB_SERVER_MAX_OPEN_SOCKETS == 7);
    assert(control_handler(&take) == ESP_OK && response_status == 200);
    assert(pending_owner == &owner && pending_generation == owner.generation);
    assert(pending_usb_generation == usb.generation && pending_until - now == INT64_C(10000000));
    int64_t deadline = pending_until;
    now += INT64_C(6000000);
    expire_control(NULL);
    assert(pending_owner == &owner && network_ends == 0);
    assert(control_handler(&take) == ESP_OK && response_status == 409 && strcmp(response_error, "busy") == 0);
    assert(pending_until == deadline);
    now = deadline - 1;
    expire_control(NULL);
    assert(pending_owner == &owner);
    now = deadline;
    expire_control(NULL);
    assert(pending_owner == NULL && network_ends == 1);
    assert(control_handler(&take) == ESP_OK && response_status == 200);
    assert(control_handler(&stop) == ESP_OK && pending_owner == NULL && network_ends == 2);

    input_client_t client = { .socket = 5, .generation = usb.generation, .last_seen = now,
        .owner = &owner, .owner_generation = owner.generation };
    active_client = &client;
    now += INT64_C(999999);
    expire_control(NULL);
    assert(active_client == &client && usb_releases == 0);
    now++;
    expire_control(NULL);
    assert(active_client == NULL && usb_releases == 1 && closed_sockets == 1);
    puts("PASS: real control handler reserves 10s, expires at boundary, stops explicitly and preserves 1s active lease");
}
