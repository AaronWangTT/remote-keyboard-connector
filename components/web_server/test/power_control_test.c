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
static bool network_stops;
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
bool usb_keyboard_begin_maintenance(void) { quiescent = false; return true; }
esp_err_t usb_keyboard_sleep(bool sleeping)
{
    if (sleeping) assert(quiescent && fake_network_state == NETWORK_SLEEP_STOPPED);
    detached = sleeping;
    return ESP_OK;
}
bool network_sleep_blocked(void) { return network_busy; }
network_control_status_t network_control_status(uint32_t generation) { (void)generation; return (network_control_status_t){.ready = network_ready}; }
bool network_sleep_begin(void) { if (network_busy) return false; fake_network_state = NETWORK_SLEEP_RESERVED; return true; }
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

static void release_input(void) { release_calls++; }
static void poll(void) { power_control_poll(true, false, release_input); }

static void reset(void)
{
    now = 1000000;
    supported = wake_released = quiescent = release_completes = network_ready = network_stops = true;
    network_busy = fail_task = detached = entered = false;
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

int main(void)
{
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
