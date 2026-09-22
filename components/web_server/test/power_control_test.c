#include "idf_stubs.h"
#include "board_power.h"
#include "firmware_update.h"
#include "network.h"
#include "usb_keyboard.h"

#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>

static int64_t now;
static bool supported;
static bool wake_released;
static bool quiescent;
static bool release_completes;
static bool network_ready;
static bool network_busy;
static bool management_grace;
static bool network_stops;
static bool reserve_allowed;
static bool fail_task;
static bool detached;
static bool entered;
static esp_err_t store_result;
static esp_err_t load_result;
static esp_err_t prepare_result;
static uint32_t saved_timeout;
static unsigned release_calls;
static unsigned store_calls;
static network_sleep_state_t fake_network_state;
static firmware_update_status_t update;
static TaskFunction_t worker;
static jmp_buf task_exit;

bool board_power_supported(void) { return supported; }
esp_err_t board_power_init(void) { return ESP_OK; }
esp_err_t board_power_load_timeout(uint32_t *minutes) { *minutes = saved_timeout; return load_result; }
esp_err_t board_power_save_timeout(uint32_t minutes) { store_calls++; if (store_result == ESP_OK) saved_timeout = minutes; return store_result; }
bool board_power_wake_released(void) { return wake_released; }
esp_err_t board_power_prepare_sleep(void) { return prepare_result; }
esp_err_t board_power_cancel_sleep(void) { return ESP_OK; }
esp_err_t board_power_enter_sleep(void)
{
    assert(detached && fake_network_state == NETWORK_SLEEP_STOPPED && quiescent);
    entered = true;
    return ESP_ERR_SLEEP_REJECT;
}
bool usb_keyboard_quiescent(void) { return quiescent; }
usb_keyboard_status_t usb_keyboard_status(void) { return (usb_keyboard_status_t){.generation = 9}; }
bool usb_keyboard_begin_maintenance(void) { quiescent = false; return true; }
esp_err_t usb_keyboard_sleep(bool sleeping)
{
    if (sleeping) assert(quiescent && fake_network_state == NETWORK_SLEEP_STOPPED);
    detached = sleeping;
    return ESP_OK;
}
bool network_sleep_blocked(void) { return network_busy || management_grace; }
void network_status(network_status_t *snapshot) { *snapshot = (network_status_t){.available = true, .busy = network_busy}; }
network_control_status_t network_control_status(uint32_t generation) { (void)generation; return (network_control_status_t){.ready = network_ready}; }
bool network_operation_busy(void) { return network_busy; }
bool network_sleep_begin(uint32_t generation) { assert(generation == 9); if (network_busy || !reserve_allowed) return false; fake_network_state = NETWORK_SLEEP_RESERVED; return true; }
bool network_sleep_stop(void) { assert(fake_network_state == NETWORK_SLEEP_RESERVED); fake_network_state = NETWORK_SLEEP_STOPPING; return true; }
network_sleep_state_t network_sleep_state(void) { return fake_network_state; }
void network_sleep_end(void) { fake_network_state = NETWORK_SLEEP_AWAKE; }
firmware_update_status_t firmware_update_status(void) { return update; }
int64_t esp_timer_get_time(void) { return now; }
const char *esp_err_to_name(esp_err_t result) { (void)result; return "test_result"; }
void test_log(const char *tag, const char *format, ...) { assert(tag != NULL && format != NULL); }
void test_enter_critical(portMUX_TYPE *lock) { assert(*lock == 0); *lock = 1; }
void test_exit_critical(portMUX_TYPE *lock) { assert(*lock == 1); *lock = 0; }
int xTaskCreate(TaskFunction_t entry, const char *name, uint32_t stack_size, void *argument,
                unsigned priority, TaskHandle_t *handle)
{
    assert(strcmp(name, "board_sleep") == 0 && stack_size >= 4096 && argument == NULL && priority == 2 && handle == NULL);
    if (fail_task) return 0;
    worker = entry;
    return pdPASS;
}
void vTaskDelay(TickType_t ticks)
{
    now += (int64_t)ticks * 1000;
    if (release_completes) quiescent = true;
    if (network_stops && fake_network_state == NETWORK_SLEEP_STOPPING) fake_network_state = NETWORK_SLEEP_STOPPED;
}
void vTaskDelete(TaskHandle_t handle) { assert(handle == NULL); longjmp(task_exit, 1); }

#include "../power_control.c"

#define HTTP_GET 0
#define HTTP_POST 1
typedef struct {
    int method;
    size_t content_len;
    const char *content_type;
    const char *body;
    size_t offset;
} httpd_req_t;
static void *active_client;
static void *pending_owner;
static int http_status;
static bool authenticated = true;
static bool origin_allowed = true;
static char http_reply[192];

static void response_headers(httpd_req_t *request) { (void)request; }
static void expire_control(void *argument) { assert(argument == NULL); }
static esp_err_t problem(httpd_req_t *request, const char *status, const char *code)
{
    (void)request;
    assert(sscanf(status, "%d", &http_status) == 1);
    snprintf(http_reply, sizeof(http_reply), "%s", code);
    return ESP_OK;
}
static bool request_allowed(httpd_req_t *request, bool mutation)
{
    (void)mutation;
    if (!origin_allowed) problem(request, "403 Forbidden", "origin_denied");
    return origin_allowed;
}
static void *request_session(httpd_req_t *request, bool mutation)
{
    if (!authenticated) { problem(request, "401 Unauthorized", "login_required"); return NULL; }
    if (mutation) management_grace = true;
    return &authenticated;
}
static bool header(httpd_req_t *request, const char *name, char *value, size_t capacity)
{
    assert(strcmp(name, "Content-Type") == 0);
    if (request->content_type == NULL || strlen(request->content_type) >= capacity) return false;
    snprintf(value, capacity, "%s", request->content_type);
    return true;
}
static int httpd_req_recv(httpd_req_t *request, char *buffer, size_t count)
{
    assert(count <= request->content_len - request->offset);
    memcpy(buffer, request->body + request->offset, count);
    request->offset += count;
    return (int)count;
}
static void httpd_resp_set_type(httpd_req_t *request, const char *type) { (void)request; assert(strcmp(type, "application/json") == 0); }
static esp_err_t httpd_resp_sendstr(httpd_req_t *request, const char *value)
{
    (void)request;
    http_status = 200;
    snprintf(http_reply, sizeof(http_reply), "%s", value);
    return ESP_OK;
}

#include "power_http.inc"

static void release_input(void) { assert(fake_network_state == NETWORK_SLEEP_RESERVED); release_calls++; }
static void poll(void) { power_control_poll(true, false, release_input); }

static void reset(void)
{
    now = 1000000;
    supported = wake_released = quiescent = release_completes = network_ready = network_stops = reserve_allowed = true;
    network_busy = management_grace = fail_task = detached = entered = false;
    load_result = store_result = prepare_result = ESP_OK;
    release_calls = store_calls = 0;
    saved_timeout = 30;
    worker = NULL;
    fake_network_state = NETWORK_SLEEP_AWAKE;
    update = (firmware_update_status_t){.available = true};
    wake_released_at = 0;
    power_control_init();
    poll();
    now += 50000;
    poll();
}

static void run_worker(void)
{
    assert(worker != NULL);
    if (setjmp(task_exit) == 0) worker(NULL);
    poll();
    assert(!power_control_status().available && !power_control_status().preparing);
    assert(fake_network_state == NETWORK_SLEEP_AWAKE && !detached);
}

static void test_power_http(void)
{
    reset();
    const char *types[] = {"application/json", "application/json; charset=utf-8"};
    for (size_t index = 0; index < sizeof(types) / sizeof(types[0]); index++) {
        const char *body = index == 0 ? "{\"idle_minutes\":60}" : "{\"idle_minutes\":30}";
        httpd_req_t request = {.method = HTTP_POST, .content_type = types[index], .body = body, .content_len = strlen(body)};
        assert(power_handler(&request) == ESP_OK && http_status == 200);
        assert(management_grace && network_sleep_blocked());
        assert(saved_timeout == (index == 0 ? 60 : 30));
    }
    unsigned previous_writes = store_calls;
    const char *body = "{\"idle_minutes\":0}";
    for (unsigned blocked = 0; blocked < 6; blocked++) {
        httpd_req_t request = {.method = HTTP_POST, .content_type = "application/json", .body = body, .content_len = strlen(body)};
        if (blocked == 0) active_client = &request;
        if (blocked == 1) pending_owner = &request;
        if (blocked == 2) network_busy = true;
        if (blocked == 3) update.busy = true;
        if (blocked == 4) update.trial_boot = true;
        if (blocked == 5) update.available = false;
        assert(power_handler(&request) == ESP_OK && http_status == 409);
        assert(store_calls == previous_writes);
        active_client = pending_owner = NULL;
        network_busy = false;
        update = (firmware_update_status_t){.available = true};
    }
    httpd_req_t request = {.method = HTTP_POST, .content_type = "text/plain", .body = body, .content_len = strlen(body)};
    assert(power_handler(&request) == ESP_OK && http_status == 400);
    assert(store_calls == previous_writes);
    authenticated = false;
    assert(power_handler(&request) == ESP_OK && http_status == 401);
    authenticated = true;
    origin_allowed = false;
    assert(power_handler(&request) == ESP_OK && http_status == 403);
    origin_allowed = true;
    request.method = HTTP_GET;
    now += 123456;
    int64_t before_activity = policy.last_activity_us;
    assert(power_handler(&request) == ESP_OK && http_status == 200);
    assert(strstr(http_reply, "\"idle_minutes\":30") != NULL && policy.last_activity_us == before_activity);
}

int main(void)
{
    test_power_http();
    const char *invalid[] = {"", "[]", "null", "{}", "{\"idle_minutes\":true}", "{\"idle_minutes\":\"30\"}",
        "{\"idle_minutes\":-1}", "{\"idle_minutes\":30.5}", "{\"idle_minutes\":1e309}",
        "{\"idle_minutes\\u0000extra\":30}",
        "{\"idle_minutes\":30,\"idle_minutes\":60}", "{\"idle_minutes\":30,\"extra\":0}", "{\"idle_minutes\":30} false"};
    uint32_t parsed = 99;
    for (size_t index = 0; index < sizeof(invalid) / sizeof(invalid[0]); index++) {
        assert(!power_control_parse_request((const uint8_t *)invalid[index], strlen(invalid[index]), &parsed));
        assert(parsed == 99);
    }
    const char embedded[] = "{\"idle_minutes\":30}\0 ";
    assert(!power_control_parse_request((const uint8_t *)embedded, sizeof(embedded) - 1, &parsed));
    const char *valid[] = {"{\"idle_minutes\":0}", "{\"idle_minutes\":30}", "{\"idle_minutes\":60}"};
    const uint32_t expected[] = {0, 30, 60};
    for (size_t index = 0; index < sizeof(valid) / sizeof(valid[0]); index++) {
        assert(power_control_parse_request((const uint8_t *)valid[index], strlen(valid[index]), &parsed));
        assert(parsed == expected[index]);
    }
    const int64_t timeout = INT64_C(1800000000);
    reset();
    assert(power_control_status().supported && power_control_status().available);
    now += timeout - 1;
    poll();
    assert(worker == NULL);
    power_control_activity();
    now += timeout - 1;
    poll();
    assert(worker == NULL);
    now++;
    poll();
    assert(worker != NULL && release_calls == 1 && power_control_status().preparing);
    assert(power_control_configure(0) == ESP_ERR_INVALID_STATE);
    run_worker();
    assert(entered);

    for (unsigned blocker = 0; blocker < 7; blocker++) {
        reset();
        now += timeout;
        if (blocker == 0) update.busy = true;
        if (blocker == 1) update.trial_boot = true;
        if (blocker == 2) update.available = false;
        if (blocker == 3) quiescent = false;
        if (blocker == 4) network_busy = true;
        power_control_poll(blocker != 5, blocker == 6, release_input);
        assert(worker == NULL && release_calls == 0);
        update = (firmware_update_status_t){.available = true};
        quiescent = true;
        network_busy = false;
        poll();
        assert(worker == NULL);
        now += timeout;
        poll();
        assert(worker != NULL);
    }

    reset();
    now += timeout;
    network_ready = false;
    poll();
    assert(worker == NULL);
    network_ready = true;
    poll();
    assert(worker != NULL);

    reset();
    now += timeout;
    reserve_allowed = false;
    int64_t last_activity = policy.last_activity_us;
    poll();
    assert(worker == NULL && release_calls == 0 && policy.last_activity_us == last_activity);
    reserve_allowed = true;
    poll();
    assert(worker != NULL && release_calls == 1);

    reset();
    assert(power_control_configure(42) == ESP_ERR_INVALID_ARG && store_calls == 0);
    assert(power_control_configure(30) == ESP_OK && store_calls == 0);
    assert(power_control_configure(60) == ESP_OK && saved_timeout == 60);
    assert(power_control_configure(0) == ESP_OK && saved_timeout == 0);
    now += timeout * 10;
    poll();
    assert(worker == NULL);
    store_result = ESP_FAIL;
    assert(power_control_configure(30) == ESP_FAIL && !power_control_status().available);
    assert(power_control_status().idle_minutes == 0);

    for (unsigned failure = 0; failure < 5; failure++) {
        reset();
        if (failure == 0) prepare_result = ESP_FAIL;
        if (failure == 1) release_completes = false;
        if (failure == 2) network_stops = false;
        if (failure == 3) fail_task = true;
        if (failure == 4) wake_released = false;
        now += timeout;
        poll();
        if (failure < 3) run_worker();
        else assert(worker == NULL);
        assert(!entered && !detached);
    }
    reset();
    supported = false;
    power_control_init();
    now += timeout;
    poll();
    assert(!power_control_status().supported && worker == NULL);
    assert(power_control_configure(30) == ESP_ERR_NOT_SUPPORTED);
    supported = true;
    load_result = ESP_FAIL;
    power_control_init();
    poll();
    assert(!power_control_status().available && worker == NULL);
    puts("PASS: power coordinator activity, blockers, reservations, settings and fail-closed shutdown");
    return 0;
}
