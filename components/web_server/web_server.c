#include "web_server.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <inttypes.h>

#include "esp_http_server.h"
#include "esp_timer.h"
#include "input_protocol.h"
#include "usb_keyboard.h"

extern const char index_start[] asm("_binary_index_html_start");
extern const char index_end[] asm("_binary_index_html_end");
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

typedef struct {
    const char *uri;
    const char *content_type;
    const char *start;
    const char *end;
} web_asset_t;

static const web_asset_t assets[] = {
    {"/", "text/html; charset=utf-8", index_start, index_end},
    {"/app.css", "text/css; charset=utf-8", css_start, css_end},
    {"/app.mjs", "text/javascript; charset=utf-8", javascript_start, javascript_end},
    {"/keyboard.mjs", "text/javascript; charset=utf-8", keyboard_start, keyboard_end},
    {"/icons/shift.svg", "image/svg+xml", shift_start, shift_end},
    {"/icons/caps.svg", "image/svg+xml", caps_start, caps_end},
    {"/icons/backspace.svg", "image/svg+xml", backspace_start, backspace_end},
    {"/icons/return.svg", "image/svg+xml", return_start, return_end},
    {"/icons/release.svg", "image/svg+xml", release_start, release_end},
};

typedef struct {
    int socket;
    uint32_t generation;
    uint32_t last_sequence;
    int64_t last_seen;
} input_client_t;

static input_client_t *active_client;

static void free_input_client(void *context)
{
    input_client_t *client = context;
    if (active_client == client) {
        usb_keyboard_release(client->generation);
        active_client = NULL;
    }
    free(client);
}

static esp_err_t input_handshake(httpd_req_t *request)
{
    int64_t now = esp_timer_get_time();
    usb_keyboard_status_t status = usb_keyboard_status();
    if (active_client != NULL &&
        (active_client->generation != status.generation ||
         now - active_client->last_seen >= INT64_C(1000000))) {
        usb_keyboard_release(active_client->generation);
        httpd_sess_trigger_close(request->handle, active_client->socket);
        active_client = NULL;
        status = usb_keyboard_status();
    }
    if (active_client != NULL) {
        httpd_resp_set_status(request, "409 Conflict");
        httpd_resp_sendstr(request, "busy");
        return ESP_FAIL;
    }
    input_client_t *client = calloc(1, sizeof(*client));
    if (client == NULL) {
        httpd_resp_set_status(request, "503 Service Unavailable");
        httpd_resp_sendstr(request, "unavailable");
        return ESP_FAIL;
    }
    client->socket = httpd_req_to_sockfd(request);
    client->generation = status.generation;
    client->last_seen = now;
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
        now - client->last_seen >= INT64_C(1000000)) {
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
    if (now - client->last_seen >= INT64_C(1000000) || client->generation != status.generation) {
        return input_fault(client);
    }
    client->last_seen = now;
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
    const web_asset_t *asset = request->user_ctx;
    response_headers(request);
    httpd_resp_set_type(request, asset->content_type);
    return httpd_resp_send(request, asset->start, asset->end - asset->start - 1);
}

static esp_err_t status_handler(httpd_req_t *request)
{
    response_headers(request);
    httpd_resp_set_type(request, "application/json");
    char reply[128];
    status_json(reply, sizeof(reply), usb_keyboard_status());
    return httpd_resp_sendstr(request, reply);
}

esp_err_t web_server_start(void)
{
    httpd_handle_t server = NULL;
    httpd_config_t configuration = HTTPD_DEFAULT_CONFIG();
    configuration.max_uri_handlers = sizeof(assets) / sizeof(assets[0]) + 2;
    configuration.max_open_sockets = 7;
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
    }
    return result;
}