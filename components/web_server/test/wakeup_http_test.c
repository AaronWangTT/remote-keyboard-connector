#include "idf_stubs.h"
#include "usb_keyboard.h"
#include "wakeup_policy.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CONFIG_LWIP_IPV6 0
#define AF_INET 2
#define ESP_ERR_HTTPD_RESULT_TRUNC 6
#define ESP_ERR_NOT_FOUND 7

typedef unsigned socklen_t;

struct sockaddr {
    unsigned short sa_family;
    char data[14];
};

struct in_addr {
    uint32_t s_addr;
};

struct sockaddr_in {
    unsigned short sin_family;
    unsigned short sin_port;
    struct in_addr sin_addr;
    unsigned char padding[8];
};

struct sockaddr_storage {
    unsigned short ss_family;
    unsigned char data[126];
};

typedef struct {
    size_t content_len;
    int socket;
    bool origin_present;
    const char *origin;
    bool transfer_encoding_present;
    const char *transfer_encoding;
} httpd_req_t;

typedef struct {
    bool preparing;
} power_control_status_t;

typedef struct {
    bool busy;
    bool trial_boot;
} firmware_update_status_t;

typedef struct {
    httpd_req_t *request;
    uint32_t request_id;
} wakeup_job_t;

static bool host_allowed;
static uint32_t peer_address;
static power_control_status_t power_status;
static firmware_update_status_t update_status;
static void *active_client;
static void *pending_owner;
static esp_err_t wake_begin_result;
static usb_keyboard_wake_status_t wake_status;
static esp_err_t async_begin_result;
static bool task_available;
static TaskFunction_t queued_worker;
static void *queued_argument;
static unsigned wake_begin_calls;
static unsigned wake_finish_calls;
static unsigned async_begin_calls;
static unsigned async_complete_calls;
static unsigned activity_calls;
static unsigned management_touch_calls;
static unsigned delays;
static int response_status;
static char response_body[192];

static uint32_t test_ntohl(uint32_t value)
{
    return ((value & UINT32_C(0x000000ff)) << 24) |
           ((value & UINT32_C(0x0000ff00)) << 8) |
           ((value & UINT32_C(0x00ff0000)) >> 8) |
           ((value & UINT32_C(0xff000000)) >> 24);
}

static int test_getpeername(int socket, struct sockaddr *address, socklen_t *length)
{
    assert(socket == 7 && *length >= sizeof(struct sockaddr_in));
    struct sockaddr_in *ipv4 = (struct sockaddr_in *)address;
    *ipv4 = (struct sockaddr_in){
        .sin_family = AF_INET,
        .sin_addr.s_addr = test_ntohl(peer_address),
    };
    *length = sizeof(*ipv4);
    return 0;
}

#define ntohl test_ntohl
#define getpeername test_getpeername

static int httpd_req_to_sockfd(httpd_req_t *request)
{
    return request->socket;
}

static esp_err_t httpd_req_get_hdr_value_str(httpd_req_t *request, const char *name,
                                              char *value, size_t capacity)
{
    bool present;
    const char *source;
    if (strcmp(name, "Origin") == 0) {
        present = request->origin_present;
        source = request->origin;
    } else {
        assert(strcmp(name, "Transfer-Encoding") == 0);
        present = request->transfer_encoding_present;
        source = request->transfer_encoding;
    }
    if (!present) return ESP_ERR_NOT_FOUND;
    assert(source != NULL && value != NULL && capacity > 0);
    size_t length = strlen(source);
    if (length + 1 > capacity) return ESP_ERR_HTTPD_RESULT_TRUNC;
    memcpy(value, source, length + 1);
    return ESP_OK;
}

static void response_headers(httpd_req_t *request)
{
    assert(request != NULL);
}

static void set_response(const char *status, const char *body)
{
    assert(sscanf(status, "%d", &response_status) == 1);
    snprintf(response_body, sizeof(response_body), "%s", body);
}

static esp_err_t problem(httpd_req_t *request, const char *status, const char *code)
{
    assert(request != NULL);
    set_response(status, code);
    return ESP_OK;
}

static bool request_allowed(httpd_req_t *request, bool mutation)
{
    assert(request != NULL && !mutation);
    if (!host_allowed) problem(request, "403 Forbidden", "origin_denied");
    return host_allowed;
}

static void httpd_resp_set_type(httpd_req_t *request, const char *type)
{
    assert(request != NULL && strcmp(type, "application/json") == 0);
}

static esp_err_t httpd_resp_sendstr(httpd_req_t *request, const char *body)
{
    assert(request != NULL);
    response_status = 200;
    snprintf(response_body, sizeof(response_body), "%s", body);
    return ESP_OK;
}

static power_control_status_t power_control_status(void)
{
    return power_status;
}

static firmware_update_status_t firmware_update_status(void)
{
    return update_status;
}

static void expire_control(void *argument)
{
    assert(argument == NULL);
}

esp_err_t usb_keyboard_wakeup_begin(uint32_t *request_id)
{
    wake_begin_calls++;
    if (wake_begin_result == ESP_OK) *request_id = 42;
    return wake_begin_result;
}

usb_keyboard_wake_status_t usb_keyboard_wakeup_status(uint32_t request_id)
{
    assert(request_id == 42);
    return wake_status;
}

void usb_keyboard_wakeup_finish(uint32_t request_id)
{
    assert(request_id == 42);
    wake_finish_calls++;
}

static void power_control_activity(void)
{
    activity_calls++;
}

static uint32_t local_address(httpd_req_t *request)
{
    assert(request != NULL);
    return 123;
}

static void network_management_touch(uint32_t address)
{
    assert(address == 123);
    management_touch_calls++;
}

static esp_err_t httpd_req_async_handler_begin(httpd_req_t *request, httpd_req_t **copy)
{
    async_begin_calls++;
    if (async_begin_result == ESP_OK) *copy = request;
    return async_begin_result;
}

static esp_err_t httpd_req_async_handler_complete(httpd_req_t *request)
{
    assert(request != NULL);
    async_complete_calls++;
    return ESP_OK;
}

int xTaskCreate(TaskFunction_t entry, const char *name, uint32_t stack_size, void *argument,
                unsigned priority, TaskHandle_t *handle)
{
    assert(strcmp(name, "usb_wakeup") == 0 && stack_size == 4096 &&
           priority == 2 && handle == NULL);
    if (!task_available) return 0;
    queued_worker = entry;
    queued_argument = argument;
    return pdPASS;
}

void vTaskDelay(TickType_t ticks)
{
    assert(ticks == 10);
    delays++;
    wake_status.state = USB_KEYBOARD_WAKE_DELIVERED;
}

void vTaskDelete(TaskHandle_t handle)
{
    assert(handle == NULL);
}

const char *esp_err_to_name(esp_err_t error)
{
    (void)error;
    return "test_error";
}

void test_log(const char *tag, const char *format, ...)
{
    assert(tag != NULL && format != NULL);
}

#include "wakeup_http.inc"

static httpd_req_t reset_request(void)
{
    host_allowed = true;
    peer_address = UINT32_C(0xc0a80102);
    power_status = (power_control_status_t){0};
    update_status = (firmware_update_status_t){0};
    active_client = pending_owner = NULL;
    wake_begin_result = ESP_OK;
    wake_status = (usb_keyboard_wake_status_t){
        .request_id = 42,
        .state = USB_KEYBOARD_WAKE_DELIVERED,
        .usb_active = true,
    };
    async_begin_result = ESP_OK;
    task_available = true;
    queued_worker = NULL;
    queued_argument = NULL;
    wake_begin_calls = wake_finish_calls = 0;
    async_begin_calls = async_complete_calls = 0;
    activity_calls = management_touch_calls = 0;
    delays = 0;
    response_status = 0;
    response_body[0] = '\0';
    return (httpd_req_t){.socket = 7};
}

static void run_worker(void)
{
    assert(queued_worker != NULL && queued_argument != NULL);
    TaskFunction_t worker = queued_worker;
    void *argument = queued_argument;
    queued_worker = NULL;
    queued_argument = NULL;
    worker(argument);
}

static void expect_rejected(httpd_req_t *request, int status, const char *error)
{
    assert(wakeup_handler(request) == ESP_OK);
    assert(response_status == status && strcmp(response_body, error) == 0);
    assert(wake_begin_calls == 0 && queued_worker == NULL);
}

static void test_request_gating(void)
{
    httpd_req_t request = reset_request();
    host_allowed = false;
    expect_rejected(&request, 403, "origin_denied");

    request = reset_request();
    peer_address = UINT32_C(0xc0a80103);
    expect_rejected(&request, 403, "wakeup_source_denied");

    request = reset_request();
    request.origin_present = true;
    request.origin = "";
    expect_rejected(&request, 403, "wakeup_source_denied");

    request = reset_request();
    request.origin_present = true;
    request.origin = "http://192.168.1.20";
    expect_rejected(&request, 403, "wakeup_source_denied");

    request = reset_request();
    request.origin_present = true;
    request.origin = "http://192.168.1.2";
    request.content_len = 1;
    expect_rejected(&request, 400, "wakeup_body_not_allowed");

    request = reset_request();
    request.transfer_encoding_present = true;
    request.transfer_encoding = "chunked";
    expect_rejected(&request, 400, "wakeup_body_not_allowed");

    request = reset_request();
    request.transfer_encoding_present = true;
    request.transfer_encoding = "";
    expect_rejected(&request, 400, "wakeup_body_not_allowed");
}

static void test_handler_errors(void)
{
    httpd_req_t request = reset_request();
    power_status.preparing = true;
    expect_rejected(&request, 503, "device_sleeping");

    request = reset_request();
    active_client = &request;
    expect_rejected(&request, 409, "device_busy");

    request = reset_request();
    update_status.trial_boot = true;
    expect_rejected(&request, 409, "device_busy");

    request = reset_request();
    wake_begin_result = ESP_ERR_NOT_SUPPORTED;
    assert(wakeup_handler(&request) == ESP_OK);
    assert(response_status == 409 &&
           strcmp(response_body, "usb_remote_wakeup_disabled") == 0);
    assert(wake_begin_calls == 1 && queued_worker == NULL);

    request = reset_request();
    wake_begin_result = ESP_ERR_INVALID_STATE;
    assert(wakeup_handler(&request) == ESP_OK);
    assert(response_status == 409 &&
           strcmp(response_body, "wakeup_unavailable_or_busy") == 0);
    assert(wake_begin_calls == 1 && queued_worker == NULL);

    request = reset_request();
    async_begin_result = ESP_FAIL;
    assert(wakeup_handler(&request) == ESP_OK);
    assert(response_status == 503 && strcmp(response_body, "unavailable") == 0);
    assert(wake_begin_calls == 1 && wake_finish_calls == 1 && async_begin_calls == 1);

    request = reset_request();
    task_available = false;
    assert(wakeup_handler(&request) == ESP_OK);
    assert(response_status == 503 && strcmp(response_body, "unavailable") == 0);
    assert(wake_finish_calls == 1 && async_complete_calls == 1);
}

static void test_worker_responses(void)
{
    httpd_req_t request = reset_request();
    request.origin_present = true;
    request.origin = "http://192.168.1.2:80";
    wake_status.state = USB_KEYBOARD_WAKE_PENDING;
    wake_status.remote_wakeup_sent = true;
    assert(wakeup_handler(&request) == ESP_OK && response_status == 0);
    assert(activity_calls == 1 && management_touch_calls == 1);
    run_worker();
    assert(delays == 1 && response_status == 200);
    assert(strstr(response_body, "\"remote_wakeup_sent\":true") != NULL);
    assert(strstr(response_body, "\"key_delivered\":true") != NULL);
    assert(wake_finish_calls == 1 && async_complete_calls == 1);

    request = reset_request();
    wake_status.state = USB_KEYBOARD_WAKE_FAILED;
    assert(wakeup_handler(&request) == ESP_OK);
    run_worker();
    assert(response_status == 503 && strcmp(response_body, "wakeup_not_delivered") == 0);
    assert(wake_finish_calls == 1 && async_complete_calls == 1);
}

int main(void)
{
    test_request_gating();
    test_handler_errors();
    test_worker_responses();
    puts("wakeup_http: request gates and HTTP success/error mappings passed");
    return 0;
}
