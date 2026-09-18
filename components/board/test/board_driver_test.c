#include "idf_stubs.h"
#include "board_status.h"

#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>

static unsigned gpio_calls;
static unsigned configure_calls;
static unsigned task_calls;
static unsigned fail_gpio_call;
static bool fail_configuration;
static bool fail_task;
static unsigned log_calls;
static unsigned deleted_tasks;
static uint32_t levels[16];
static uint64_t edge_times[16];
static uint64_t now_ms;
static uint64_t stop_at_ms;
static TaskFunction_t task_entry;
static void *task_argument;
static jmp_buf task_exit;

esp_err_t gpio_set_level(gpio_num_t pin, uint32_t level)
{
    assert(pin == GPIO_NUM_48 && level <= 1);
    assert(gpio_calls < sizeof(levels) / sizeof(levels[0]));
    levels[gpio_calls] = level;
    edge_times[gpio_calls++] = now_ms;
    return gpio_calls == fail_gpio_call ? ESP_FAIL : ESP_OK;
}

esp_err_t gpio_config(const gpio_config_t *configuration)
{
    assert(gpio_calls == 1 && levels[0] == 1);
    assert(configuration->pin_bit_mask == (UINT64_C(1) << GPIO_NUM_48));
    assert(configuration->mode == GPIO_MODE_OUTPUT);
    assert(configuration->pull_up_en == GPIO_PULLUP_DISABLE);
    assert(configuration->pull_down_en == GPIO_PULLDOWN_DISABLE);
    assert(configuration->intr_type == GPIO_INTR_DISABLE);
    configure_calls++;
    return fail_configuration ? ESP_FAIL : ESP_OK;
}

void gpio_deep_sleep_hold_dis(void)
{
    assert(configure_calls == 1 && levels[0] == 1);
}

esp_err_t gpio_hold_dis(gpio_num_t pin)
{
    assert(pin == GPIO_NUM_48 && configure_calls == 1 && levels[0] == 1);
    return ESP_OK;
}

int xTaskCreate(TaskFunction_t entry, const char *name, uint32_t stack_size, void *argument,
                unsigned priority, TaskHandle_t *handle)
{
    assert(configure_calls == 1);
    assert(strcmp(name, "board_status") == 0 && stack_size >= 2048 && priority == 1);
    task_calls++;
    if (fail_task) return 0;
    task_entry = entry;
    task_argument = argument;
    *handle = &task_calls;
    return pdPASS;
}

void vTaskDelay(TickType_t ticks)
{
    assert(ticks == BOARD_STATUS_REFRESH_MS);
    now_ms += ticks;
    if (stop_at_ms != 0 && now_ms >= stop_at_ms) longjmp(task_exit, 1);
    assert(now_ms < 2000);
}

void test_enter_critical(portMUX_TYPE *lock)
{
    assert(*lock == 0);
    *lock = 1;
}

void test_exit_critical(portMUX_TYPE *lock)
{
    assert(*lock == 1);
    *lock = 0;
}

void vTaskDelete(TaskHandle_t handle)
{
    assert(handle == NULL);
    deleted_tasks++;
    longjmp(task_exit, 1);
}

int64_t esp_timer_get_time(void)
{
    return (int64_t)(now_ms * 1000);
}

const char *esp_err_to_name(esp_err_t error)
{
    assert(error != ESP_OK);
    return "test_failure";
}

void test_log(const char *tag, const char *format, ...)
{
    assert(tag != NULL && format != NULL);
    log_calls++;
}

static board_status_snapshot_t read_status(void)
{
    return (board_status_snapshot_t){
        .valid = now_ms >= 250,
        .ready = true,
        .controller_active = now_ms >= 450,
        .sampled_at_ms = now_ms < 600 ? now_ms : 575,
    };
}

int main(void)
{
#if CONFIG_BOARD_XINLUCITY_ESP32S3_NANO && CONFIG_IDF_TARGET_ESP32S3
    assert(board_status_start(NULL) == ESP_ERR_INVALID_ARG);
    assert(gpio_calls == 0 && configure_calls == 0 && task_calls == 0);
    fail_gpio_call = 1;
    assert(board_status_start(read_status) == ESP_FAIL);
    assert(configure_calls == 0 && task_calls == 0);
    gpio_calls = 0;
    fail_gpio_call = 0;
    fail_configuration = true;
    assert(board_status_start(read_status) == ESP_FAIL);
    assert(task_calls == 0);
    gpio_calls = configure_calls = 0;
    fail_configuration = false;
    fail_task = true;
    assert(board_status_start(read_status) == ESP_ERR_NO_MEM);
    assert(gpio_calls == 1 && levels[0] == 1);
    gpio_calls = configure_calls = task_calls = 0;
    fail_task = false;
    assert(board_status_start(read_status) == ESP_OK);
    assert(task_entry != NULL && gpio_calls == 1 && levels[0] == 1);
    assert(board_status_start(read_status) == ESP_ERR_INVALID_STATE);
    assert(gpio_calls == 1 && configure_calls == 1 && task_calls == 1);
    assert(board_status_pause(true) == ESP_OK);
    assert(gpio_calls == 2 && levels[1] == 1);
    stop_at_ms = 100;
    if (setjmp(task_exit) == 0) task_entry(task_argument);
    assert(gpio_calls == 2);
    assert(board_status_pause(false) == ESP_OK);
    gpio_calls = 1;
    now_ms = stop_at_ms = 0;
    fail_gpio_call = 8;
    if (setjmp(task_exit) == 0) task_entry(task_argument);
    const uint32_t expected_levels[] = {1, 0, 1, 0, 1, 0, 1, 0, 1};
    const uint64_t expected_times[] = {0, 0, 100, 200, 350, 450, 750, 850, 850};
    assert(gpio_calls == sizeof(expected_levels) / sizeof(expected_levels[0]));
    assert(memcmp(levels, expected_levels, sizeof(expected_levels)) == 0);
    assert(memcmp(edge_times, expected_times, sizeof(expected_times)) == 0);
    assert(log_calls == 1 && deleted_tasks == 1);
    puts("PASS: G48 initialization ordering, startup failures, live/stale patterns and update failure cleanup");
#else
    assert(board_status_pause(true) == ESP_ERR_NOT_SUPPORTED);
    assert(board_status_start(NULL) == ESP_ERR_NOT_SUPPORTED);
    assert(board_status_start(read_status) == ESP_ERR_NOT_SUPPORTED);
    assert(gpio_calls == 0 && configure_calls == 0 && task_calls == 0 && log_calls == 0);
    puts("PASS: disabled/unsupported board leaves every GPIO and task untouched");
#endif
    return 0;
}