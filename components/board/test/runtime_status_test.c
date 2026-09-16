#include "idf_stubs.h"
#include "access_control.h"
#include "board_status_logic.h"
#include "network.h"
#include "network_state.h"
#include "usb_keyboard.h"
#include "web_server.h"

#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>

static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static network_status_t snapshot;
static bool control_ready;
static bool update_reserved;
static bool command_pending;
static bool guarded;
static bool guard_ap;
static uint32_t ap_address;
static uint32_t station_address;
static uint32_t lease_address;
static uint32_t guard_generation;
static network_state_t state;
static bool testing;
static int64_t management_until;
#include "network_observer.inc"
#include "network_effect_decision.inc"
#include "input_client.inc"

static input_client_t *active_client;
static int server_instance;
static httpd_handle_t server = &server_instance;
static bool server_started;
static TaskHandle_t status_task;
static portMUX_TYPE status_lock = portMUX_INITIALIZER_UNLOCKED;
static bool status_pending;
static web_server_status_t status_snapshot;

static unsigned critical_depth;
static bool check_update_after_unlock;
static uint32_t update_address;
static network_effect_t next_effect;
static unsigned state_ticks;
static bool http_owner_context;
static bool identity_ready = true;
static bool owner_claimed = true;
static bool websocket_connected = true;
static bool fail_task;
static bool change_usb_on_read;
static unsigned usb_reads;
static unsigned owner_reads;
static unsigned log_calls;
static unsigned queue_calls;
static unsigned task_calls;
static unsigned delays;
static unsigned delay_limit;
static int64_t now_us = 1000000;
static usb_keyboard_status_t usb_status = {.ready = true, .generation = 9};
static esp_err_t queue_result = ESP_OK;
static httpd_work_fn_t queued_work;
static void *queued_argument;
static TaskFunction_t worker_entry;
static void *worker_argument;
static jmp_buf worker_exit;

bool device_identity_ready(void)
{
    assert(http_owner_context);
    owner_reads++;
    return identity_ready;
}

bool device_identity_claimed(void)
{
    assert(http_owner_context);
    owner_reads++;
    return owner_claimed;
}

usb_keyboard_status_t usb_keyboard_status(void)
{
    assert(http_owner_context);
    owner_reads++;
    if (++usb_reads == 2 && change_usb_on_read) usb_status.generation++;
    return usb_status;
}

void test_enter_critical(portMUX_TYPE *mutex)
{
    assert(critical_depth == 0 && *mutex == 0);
    critical_depth++;
    *mutex = 1;
}

void test_exit_critical(portMUX_TYPE *mutex)
{
    assert(critical_depth == 1 && *mutex == 1);
    critical_depth--;
    *mutex = 0;
    if (check_update_after_unlock) {
        check_update_after_unlock = false;
        assert(!network_update_begin(update_address));
    }
}

network_effect_t network_state_tick(network_state_t *current, int64_t now, bool held)
{
    (void)now;
    (void)held;
    assert(current == &state && critical_depth == 1);
    state_ticks++;
    current->attempts++;
    return next_effect;
}

int xTaskCreate(TaskFunction_t entry, const char *name, uint32_t stack_size, void *argument,
                unsigned priority, TaskHandle_t *handle)
{
    assert(strcmp(name, "web_status") == 0 && stack_size >= 2048 && priority == 1);
    task_calls++;
    if (fail_task) return 0;
    worker_entry = entry;
    worker_argument = argument;
    *handle = &task_calls;
    return pdPASS;
}

void vTaskDelay(TickType_t ticks)
{
    assert(!http_owner_context && critical_depth == 0 && ticks == 25);
    now_us += ticks * 1000;
    if (++delays >= delay_limit) longjmp(worker_exit, 1);
}

int64_t esp_timer_get_time(void)
{
    return now_us;
}

const char *esp_err_to_name(esp_err_t error)
{
    assert(error != ESP_OK);
    return "test_failure";
}

void test_log(const char *tag, const char *format, ...)
{
    assert(tag != NULL && format != NULL && critical_depth == 0);
    log_calls++;
}

esp_err_t httpd_queue_work(httpd_handle_t handle, httpd_work_fn_t work, void *argument)
{
    assert(handle == server && !http_owner_context && critical_depth == 0);
    queue_calls++;
    if (queue_result == ESP_OK) {
        assert(queued_work == NULL);
        queued_work = work;
        queued_argument = argument;
    }
    return queue_result;
}

int httpd_ws_get_fd_info(httpd_handle_t handle, int socket)
{
    assert(http_owner_context && handle == server && socket == 7);
    owner_reads++;
    return websocket_connected ? HTTPD_WS_CLIENT_WEBSOCKET : 0;
}

#include "web_observer.inc"

static void reset_network(void)
{
    snapshot = (network_status_t){.available = true, .ap_active = true, .can_control = true};
    control_ready = true;
    command_pending = guarded = guard_ap = update_reserved = false;
    ap_address = 1;
    station_address = lease_address = guard_generation = 0;
}

static void expect_network(uint32_t generation, bool ready, bool path)
{
    network_control_status_t status = network_control_status(generation);
    assert(status.ready == ready && status.controller_path_ready == path);
    assert(critical_depth == 0);
}

static void test_network_observation(void)
{
    expect_network(0, false, false);
    reset_network();
    strcpy(snapshot.error, "scan_timeout");
    assert(!snapshot.mdns && !snapshot.station_online);
    expect_network(0, true, false);
    assert(network_control_begin(ap_address, 9));
    assert(!snapshot.can_control);
    expect_network(9, true, true);
    expect_network(10, true, false);
    snapshot.busy = true;
    expect_network(9, false, false);
    snapshot.busy = false;
    command_pending = true;
    expect_network(9, false, false);
    command_pending = false;
    snapshot.available = false;
    expect_network(9, false, false);
    snapshot.available = true;
    control_ready = false;
    expect_network(9, false, false);
    control_ready = true;
    snapshot.ap_active = false;
    snapshot.station_online = true;
    station_address = lease_address = 2;
    expect_network(9, true, false);
    network_control_end(9);
    assert(network_control_begin(station_address, 9));
    expect_network(9, true, true);
    lease_address = 0;
    expect_network(9, false, false);
    snapshot.ap_active = true;
    expect_network(9, true, false);
    network_control_end(9);
    expect_network(9, true, false);
    assert(snapshot.can_control);
    snapshot.can_control = false;
    expect_network(9, false, false);
    reset_network();
    assert(network_update_begin(ap_address));
    assert(!snapshot.can_control);
    assert(!network_control_begin(ap_address, 9));
    assert(!network_update_begin(ap_address));
    expect_network(0, false, false);
    network_update_end();
    assert(snapshot.can_control);
    snapshot.ap_active = false;
    snapshot.station_online = true;
    station_address = lease_address = 2;
    assert(!network_update_begin(ap_address));
    assert(network_update_begin(station_address));
    network_update_end();
    lease_address = 0;
    assert(!network_update_begin(station_address));
    lease_address = 2;
    command_pending = true;
    assert(!network_update_begin(station_address));
    command_pending = false;
    guarded = true;
    assert(!network_update_begin(station_address));
    const network_effect_t effects[] = {NETWORK_TRY_CONNECT, NETWORK_OPEN_AP, NETWORK_CLOSE_AP};
    for (uint32_t address = 1; address <= 2; address++) {
        for (size_t index = 0; index < sizeof(effects) / sizeof(effects[0]); index++) {
            reset_network();
            snapshot.station_online = true;
            station_address = lease_address = 2;
            state = (network_state_t){0};
            state_ticks = 0;
            next_effect = effects[index];
            update_address = address;
            check_update_after_unlock = true;
            assert(network_test_effect(now_us) == effects[index]);
            assert(!check_update_after_unlock && state_ticks == 1 && state.attempts == 1);
            assert(!control_ready && !update_reserved && !snapshot.can_control);

            control_ready = true;
            snapshot.can_control = true;
            assert(network_update_begin(address));
            assert(network_test_effect(now_us) == NETWORK_WAIT);
            assert(state_ticks == 1 && state.attempts == 1 && update_reserved);
            network_update_end();
        }
    }
    reset_network();
}

static void publish(void)
{
    usb_reads = 0;
    http_owner_context = true;
    publish_status(NULL);
    http_owner_context = false;
    assert(critical_depth == 0 && !status_pending);
}

static web_server_status_t expect_web(bool valid, bool ready, bool active)
{
    unsigned previous_reads = owner_reads;
    web_server_status_t status = web_server_status();
    assert(status.valid == valid && status.ready == ready && status.controller_active == active);
    assert(owner_reads == previous_reads && critical_depth == 0);
    return status;
}

static board_status_t indicated_status(void)
{
    web_server_status_t status = web_server_status();
    board_status_snapshot_t indicator = {
        .valid = status.valid, .ready = status.ready, .controller_active = status.controller_active,
        .sampled_at_ms = status.sampled_at_ms,
    };
    return board_status_select(&indicator, (uint64_t)(now_us / 1000));
}

static void run_worker(unsigned steps)
{
    delays = 0;
    delay_limit = steps;
    if (setjmp(worker_exit) == 0) worker_entry(worker_argument);
    assert(critical_depth == 0);
}

static void test_http_observation(void)
{
    expect_web(false, false, false);
    assert(web_server_status_start() == ESP_ERR_INVALID_STATE && task_calls == 0);
    server_started = true;
    fail_task = true;
    assert(web_server_status_start() == ESP_ERR_NO_MEM);
    expect_web(false, false, false);
    fail_task = false;
    assert(web_server_status_start() == ESP_OK);
    assert(worker_entry != NULL && web_server_status_start() == ESP_ERR_INVALID_STATE);
    access_control_t control = {0};
    const char *token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    access_session_t *session = access_session_create(&control, token, token, now_us);
    assert(session != NULL);
    access_session_t original = *session;
    input_client_t client = {.socket = 7, .generation = 9, .last_seen = now_us,
                            .owner = session, .owner_generation = session->generation};
    assert(network_control_begin(ap_address, client.generation));
    publish();
    expect_web(true, true, false);
    active_client = &client;
    publish();
    web_server_status_t status = expect_web(true, true, true);
    assert(status.sampled_at_ms == (uint64_t)(now_us / 1000));
    assert(!snapshot.can_control && indicated_status() == BOARD_STATUS_CONTROL_ACTIVE);
    identity_ready = false;
    publish();
    expect_web(true, false, false);
    identity_ready = true;
    owner_claimed = false;
    publish();
    expect_web(true, false, false);
    owner_claimed = true;
    websocket_connected = false;
    publish();
    expect_web(true, true, false);
    websocket_connected = true;
    usb_status.ready = false;
    publish();
    expect_web(true, false, false);
    usb_status.ready = true;
    usb_status.generation++;
    publish();
    expect_web(true, true, false);
    usb_status.generation--;
    change_usb_on_read = true;
    publish();
    assert(!web_server_status().valid && indicated_status() == BOARD_STATUS_NOT_READY);
    change_usb_on_read = false;
    usb_status.generation--;
    now_us += ACCESS_CONTROL_LEASE_US;
    publish();
    expect_web(true, true, false);
    now_us = original.last_seen + ACCESS_IDLE_US;
    client.last_seen = now_us;
    publish();
    expect_web(true, true, false);
    assert(memcmp(session, &original, sizeof(original)) == 0);
    now_us = original.last_seen + 1;
    client.last_seen = now_us;
    access_session_revoke(session);
    publish();
    expect_web(true, true, false);
    assert(session->generation == 0);
    *session = original;
    network_control_end(client.generation);
    publish();
    expect_web(true, true, false);
    assert(network_control_begin(ap_address, client.generation));
    publish();
    expect_web(true, true, true);
    unsigned previous_reads = owner_reads;
    run_worker(4);
    assert(queue_calls == 1 && status_pending && queued_work != NULL);
    assert(owner_reads == previous_reads);
    assert(indicated_status() == BOARD_STATUS_NOT_READY);
    httpd_work_fn_t work = queued_work;
    queued_work = NULL;
    http_owner_context = true;
    work(queued_argument);
    http_owner_context = false;
    assert(!status_pending && indicated_status() == BOARD_STATUS_CONTROL_ACTIVE);
    queue_result = ESP_FAIL;
    run_worker(3);
    assert(queue_calls == 4 && !status_pending && queued_work == NULL && log_calls == 1);
    assert(!web_server_status().valid && indicated_status() == BOARD_STATUS_NOT_READY);
    assert(memcmp(session, &original, sizeof(original)) == 0);
    active_client = NULL;
}

int main(void)
{
    test_network_observation();
    test_http_observation();
    puts("PASS: AP-only capability, reservations, HTTP-owner snapshots, USB races, expiry, bounded queues and stale status");
    return 0;
}