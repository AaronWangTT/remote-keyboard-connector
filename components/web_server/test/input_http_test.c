#include "idf_stubs.h"
#include "access_control.h"
#include "input_protocol.h"
#include "keyboard_state.h"
#include "usb_keyboard.h"

#include <assert.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

typedef struct { void *sess_ctx; httpd_handle_t handle; } httpd_req_t;
typedef struct {
    int type;
    bool final;
    uint8_t *payload;
    size_t len;
} httpd_ws_frame_t;
enum { HTTPD_WS_TYPE_TEXT = 1 };
#include "input_client.inc"
static input_client_t *active_client;
static keyboard_state_t keyboard;
static access_control_t access;
static int64_t now;
static const char *incoming;
static char reply[128];
static unsigned activity;

int64_t esp_timer_get_time(void) { return now; }
usb_keyboard_status_t usb_keyboard_status(void)
{
    keyboard_state_tick(&keyboard, now);
    return (usb_keyboard_status_t) {
        .ready = keyboard_state_ready(&keyboard), .generation = keyboard.generation,
        .input_paused = keyboard.input_paused,
    };
}
bool usb_keyboard_submit(uint32_t generation, const keyboard_report_t *report)
{
    return keyboard_state_input(&keyboard, generation, report, now);
}
bool usb_keyboard_heartbeat(uint32_t generation)
{
    return keyboard_state_heartbeat(&keyboard, generation, now);
}
bool usb_keyboard_pause(uint32_t generation)
{
    if (generation != keyboard.generation) return false;
    keyboard_state_pause(&keyboard);
    return true;
}
bool usb_keyboard_resume(uint32_t generation)
{
    return keyboard_state_resume(&keyboard, generation, now);
}
void usb_keyboard_release(uint32_t generation)
{
    if (generation == keyboard.generation) keyboard_state_release(&keyboard);
}
static void power_control_activity(void) { activity++; }
static int httpd_req_to_sockfd(httpd_req_t *request) { (void)request; return 5; }
int httpd_ws_get_fd_info(httpd_handle_t handle, int socket)
{
    (void)handle;
    assert(socket == 5);
    return HTTPD_WS_CLIENT_WEBSOCKET;
}
static void httpd_resp_set_status(httpd_req_t *request, const char *status)
{
    (void)request;
    (void)status;
    assert(false);
}
static esp_err_t httpd_resp_sendstr(httpd_req_t *request, const char *message)
{
    (void)request;
    (void)message;
    assert(false);
    return ESP_FAIL;
}
static esp_err_t httpd_ws_recv_frame(httpd_req_t *request, httpd_ws_frame_t *frame, size_t capacity)
{
    (void)request;
    if (capacity == 0) {
        frame->type = HTTPD_WS_TYPE_TEXT;
        frame->final = true;
        frame->len = strlen(incoming);
    } else {
        assert(capacity >= strlen(incoming));
        memcpy(frame->payload, incoming, strlen(incoming));
    }
    return ESP_OK;
}
static esp_err_t httpd_ws_send_frame(httpd_req_t *request, httpd_ws_frame_t *frame)
{
    (void)request;
    assert(frame->len < sizeof(reply));
    memcpy(reply, frame->payload, frame->len);
    reply[frame->len] = 0;
    return ESP_OK;
}

#include "input_http.inc"

static void complete_neutral(void)
{
    keyboard_report_t report;
    assert(keyboard_state_next(&keyboard, now, &report));
    assert(keyboard_report_empty(&report));
    keyboard_state_complete(&keyboard);
}

static void start(input_client_t *client)
{
    now = 1;
    access = (access_control_t){0};
    keyboard_state_init(&keyboard);
    keyboard_state_usb(&keyboard, true);
    complete_neutral();
    access_session_t *owner = access_session_create(&access,
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", now);
    assert(owner != NULL);
    *client = (input_client_t){ .socket = 5, .generation = keyboard.generation,
        .last_seen = now, .owner = owner, .owner_generation = owner->generation };
    active_client = client;
    activity = 0;
}

static esp_err_t exchange(input_client_t *client, const char *message)
{
    incoming = message;
    reply[0] = 0;
    httpd_req_t request = {.sess_ctx = client};
    return input_handler(&request);
}

int main(void)
{
    input_client_t client;
    start(&client);
    now += INT64_C(4999999);
    assert(exchange(&client, "{\"v\":1,\"type\":\"ping\"}") == ESP_OK);
    assert(strstr(reply, "\"input_paused\":false") != NULL);
    now += INT64_C(5000000);
    assert(exchange(&client, "{\"v\":1,\"type\":\"ping\"}") == ESP_FAIL);

    start(&client);
    assert(exchange(&client, "{\"v\":1,\"type\":\"state\",\"seq\":1,\"modifiers\":0,\"keys\":[4]}") == ESP_OK);
    keyboard_report_t report;
    assert(keyboard_state_next(&keyboard, now, &report) && report.keys[0] == 4);
    keyboard_state_complete(&keyboard);
    now += KEYBOARD_IDLE_TIMEOUT_US;
    assert(exchange(&client, "{\"v\":1,\"type\":\"state\",\"seq\":2,\"modifiers\":0,\"keys\":[5]}") == ESP_OK);
    assert(strstr(reply, "\"input_paused\":true") != NULL && client.last_sequence == 2);
    assert(keyboard.generation == client.generation && keyboard.count == 0 && activity == 1);
    assert(exchange(&client, "{\"v\":1,\"type\":\"resume\"}") == ESP_OK);
    assert(strstr(reply, "\"usb_ready\":false") != NULL);
    complete_neutral();
    assert(exchange(&client, "{\"v\":1,\"type\":\"ping\"}") == ESP_OK && keyboard.input_paused);
    assert(exchange(&client, "{\"v\":1,\"type\":\"reset\"}") == ESP_OK && keyboard.input_paused);
    assert(exchange(&client, "{\"v\":1,\"type\":\"resume\"}") == ESP_OK);
    assert(strcmp(reply, "{\"v\":1,\"type\":\"resumed\"}") == 0 && !keyboard.input_paused);
    assert(!keyboard_state_next(&keyboard, now, &report));
    assert(exchange(&client, "{\"v\":1,\"type\":\"state\",\"seq\":3,\"modifiers\":0,\"keys\":[6]}") == ESP_OK);
    assert(strstr(reply, "\"queued\"") != NULL && activity == 2);
    assert(keyboard_state_next(&keyboard, now, &report) && report.keys[0] == 6);
    keyboard_state_complete(&keyboard);
    assert(exchange(&client, "{\"v\":1,\"type\":\"reset\"}") == ESP_OK);
    assert(keyboard.input_paused && keyboard.count == 0);
    complete_neutral();
    assert(exchange(&client, "{\"v\":1,\"type\":\"resume\"}") == ESP_OK);
    assert(exchange(&client, "{\"v\":1,\"type\":\"state\",\"seq\":5,\"modifiers\":0,\"keys\":[4]}") == ESP_FAIL);

    start(&client);
    assert(exchange(&client, "{\"v\":1,\"type\":\"reset\"}") == ESP_OK);
    assert(keyboard_state_next(&keyboard, now, &report));
    now += KEYBOARD_REPORT_TIMEOUT_US;
    assert(exchange(&client, "{\"v\":1,\"type\":\"ping\"}") == ESP_FAIL);
    assert(keyboard.generation != client.generation);
    puts("PASS: real input handler preserves 5s idle leases, pauses held input at 1s, discards stale states and resumes only after neutral USB completion");
}
