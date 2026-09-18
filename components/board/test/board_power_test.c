#include "idf_stubs.h"
#include "board_power.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned hardware_calls;
static unsigned sleep_calls;
static unsigned writes;
static unsigned commits;
static bool released = true;
static bool paused;
static bool held;
static bool deep_hold;
static bool wake_enabled;
static bool rtc_mux;
static bool rtc_hold;
static uint32_t stored_minutes = 60;
static esp_err_t open_result = ESP_OK;
static esp_err_t get_result = ESP_OK;
static esp_err_t write_result = ESP_OK;
static esp_err_t commit_result = ESP_OK;
static esp_err_t wake_result = ESP_OK;
static esp_err_t pause_result = ESP_OK;

#ifdef BOARD_POWER_TEST_SDK_SLEEP
#define BIT(bit) (UINT32_C(1) << (bit))
enum { RTCIO_LL_FUNC_RTC = 1, RTCIO_LL_PIN_FUNC = 0, ESP_PD_DOMAIN_RTC_PERIPH = 0, ESP_PD_OPTION_ON = 1 };
static struct {
    uint32_t ext1_rtc_gpio_mask;
    uint32_t ext1_trigger_mode;
    struct { int pd_option; } domain[1];
} s_config;
static bool rtc_input;
static bool rtc_iomux;
static bool rtc_status_cleared;
static bool rtc_pins_armed;
static void rtcio_ll_enable_io_clock(bool enabled) { assert(enabled); }
static int rtc_io_number_get(int gpio) { assert(gpio == 0); return 0; }
static void rtcio_hal_function_select(int pin, int function) { assert(pin == 0 && function == RTCIO_LL_FUNC_RTC); rtc_mux = true; }
static void rtcio_hal_iomux_func_sel(int pin, int function) { assert(pin == 0 && function == RTCIO_LL_PIN_FUNC); rtc_iomux = true; }
static void rtcio_hal_input_enable(int pin) { assert(pin == 0 && rtc_mux && rtc_iomux); rtc_input = true; }
static void rtcio_hal_hold_enable(int pin) { assert(pin == 0 && rtc_input); rtc_hold = true; }
static void rtc_hal_ext1_clear_wakeup_status(void) { rtc_status_cleared = true; }
static void rtc_hal_ext1_set_wakeup_pins(uint32_t mask, uint32_t level)
{
    assert(mask == 1 && level == 0 && rtc_status_cleared);
    rtc_pins_armed = true;
}
#include "sdk_sleep_prepare.inc"
_Static_assert(SOC_GPIO_PIN_COUNT == 49 && SOC_RTCIO_INPUT_OUTPUT_SUPPORTED && SOC_PM_SUPPORT_RTC_PERIPH_PD,
    "This fixture must exercise the actual ESP32-S3 RTC wake and hold path");
#endif

esp_err_t gpio_config(const gpio_config_t *configuration)
{
    hardware_calls++;
    assert(configuration->pin_bit_mask == 1 && configuration->mode == GPIO_MODE_INPUT);
    assert(configuration->pull_up_en == GPIO_PULLUP_ENABLE && configuration->pull_down_en == GPIO_PULLDOWN_DISABLE);
    return ESP_OK;
}
int gpio_get_level(gpio_num_t pin) { assert(pin == GPIO_NUM_0 && !rtc_mux); hardware_calls++; return released; }
esp_err_t rtc_gpio_deinit(gpio_num_t pin) { assert(pin == GPIO_NUM_0 && !rtc_hold); rtc_mux = false; hardware_calls++; return ESP_OK; }
esp_err_t rtc_gpio_hold_dis(gpio_num_t pin) { assert(pin == GPIO_NUM_0); rtc_hold = false; hardware_calls++; return ESP_OK; }
esp_err_t rtc_gpio_pullup_en(gpio_num_t pin) { assert(pin == GPIO_NUM_0); hardware_calls++; return ESP_OK; }
esp_err_t rtc_gpio_pulldown_dis(gpio_num_t pin) { assert(pin == GPIO_NUM_0); hardware_calls++; return ESP_OK; }
esp_err_t gpio_hold_en(gpio_num_t pin) { assert(pin == GPIO_NUM_48 && paused); held = true; return ESP_OK; }
esp_err_t gpio_hold_dis(gpio_num_t pin) { assert(pin == GPIO_NUM_48 && !deep_hold); held = false; return ESP_OK; }
void gpio_deep_sleep_hold_en(void) { assert(held); deep_hold = true; }
void gpio_deep_sleep_hold_dis(void) { deep_hold = false; }
esp_err_t board_status_pause(bool value) { paused = value; return value ? pause_result : ESP_OK; }
esp_err_t esp_sleep_disable_wakeup_source(int source) { assert(source == ESP_SLEEP_WAKEUP_ALL); wake_enabled = false; return ESP_OK; }
esp_err_t esp_sleep_enable_ext1_wakeup_io(uint64_t pins, int level)
{
    assert(pins == 1 && level == ESP_EXT1_WAKEUP_ANY_LOW);
    wake_enabled = wake_result == ESP_OK;
    return wake_result;
}
esp_err_t esp_sleep_disable_ext1_wakeup_io(uint64_t pins) { assert(pins == 1); wake_enabled = false; return ESP_OK; }
esp_err_t esp_deep_sleep_try_to_start(void)
{
    assert(wake_enabled && paused && held && deep_hold && released);
#ifdef BOARD_POWER_TEST_SDK_SLEEP
    assert(!rtc_mux && !rtc_hold);
    s_config.ext1_rtc_gpio_mask = 1;
    s_config.ext1_trigger_mode = 0;
    ext1_wakeup_prepare();
    assert(rtc_mux && rtc_iomux && rtc_input && rtc_hold && rtc_pins_armed);
#endif
    sleep_calls++;
    return ESP_ERR_SLEEP_REJECT;
}
esp_err_t nvs_open(const char *name, nvs_open_mode_t mode, nvs_handle_t *handle)
{
    assert(strcmp(name, "board_power") == 0 && (mode == NVS_READONLY || mode == NVS_READWRITE));
    *handle = 1;
    return open_result;
}
esp_err_t nvs_get_u32(nvs_handle_t handle, const char *key, uint32_t *value)
{
    assert(handle == 1 && strcmp(key, "idle_minutes") == 0);
    *value = stored_minutes;
    return get_result;
}
esp_err_t nvs_set_u32(nvs_handle_t handle, const char *key, uint32_t value)
{
    assert(handle == 1 && strcmp(key, "idle_minutes") == 0);
    writes++;
    if (write_result == ESP_OK) stored_minutes = value;
    return write_result;
}
esp_err_t nvs_commit(nvs_handle_t handle) { assert(handle == 1); commits++; return commit_result; }
void nvs_close(nvs_handle_t handle) { assert(handle == 1); }

int main(void)
{
    uint32_t timeout = 99;
#if CONFIG_BOARD_POWER_MANAGEMENT && CONFIG_BOARD_XINLUCITY_ESP32S3_NANO && CONFIG_IDF_TARGET_ESP32S3
    assert(board_power_supported());
    assert(!board_power_wake_released());
    assert(board_power_init() == ESP_OK && board_power_wake_released());
    open_result = ESP_ERR_NVS_NOT_FOUND;
    assert(board_power_load_timeout(&timeout) == ESP_OK && timeout == 30);
    open_result = ESP_FAIL;
    assert(board_power_load_timeout(&timeout) == ESP_FAIL);
    open_result = ESP_OK;
    get_result = ESP_ERR_NVS_NOT_FOUND;
    assert(board_power_load_timeout(&timeout) == ESP_OK && timeout == 30);
    get_result = ESP_FAIL;
    assert(board_power_load_timeout(&timeout) == ESP_FAIL);
    get_result = ESP_OK;
    assert(board_power_load_timeout(&timeout) == ESP_OK && timeout == 60 && writes == 0);
    stored_minutes = 42;
    assert(board_power_load_timeout(&timeout) == ESP_ERR_INVALID_STATE);
    assert(board_power_save_timeout(42) == ESP_ERR_INVALID_ARG && writes == 0);
    assert(board_power_save_timeout(0) == ESP_OK && writes == 1 && commits == 1);
    assert(board_power_load_timeout(&timeout) == ESP_OK && timeout == 0);
    write_result = ESP_FAIL;
    assert(board_power_save_timeout(30) == ESP_FAIL && commits == 1);
    write_result = ESP_OK;
    commit_result = ESP_FAIL;
    assert(board_power_save_timeout(60) == ESP_FAIL && commits == 2);

    released = false;
    assert(board_power_prepare_sleep() == ESP_ERR_INVALID_STATE && !wake_enabled);
    released = true;
    wake_result = ESP_FAIL;
    assert(board_power_prepare_sleep() == ESP_FAIL);
    assert(board_power_enter_sleep() == ESP_ERR_INVALID_STATE && sleep_calls == 0);
    wake_result = ESP_OK;
    assert(board_power_prepare_sleep() == ESP_OK);
    released = false;
    assert(board_power_enter_sleep() == ESP_ERR_INVALID_STATE && sleep_calls == 0);
    released = true;
    pause_result = ESP_FAIL;
    assert(board_power_enter_sleep() == ESP_FAIL && sleep_calls == 0 && !held && !paused);
    pause_result = ESP_OK;
    assert(board_power_enter_sleep() == ESP_ERR_SLEEP_REJECT && sleep_calls == 1);
    assert(!held && !deep_hold && !paused);
    assert(board_power_cancel_sleep() == ESP_OK && !wake_enabled);
    assert(!rtc_mux && !rtc_hold && board_power_wake_released());
    assert(board_power_enter_sleep() == ESP_ERR_INVALID_STATE);
#ifdef BOARD_POWER_TEST_SDK_SLEEP
    puts("PASS: actual SDK EXT1 preparation selects RTC mux/input/hold and abort restores digital BOOT");
#endif
    puts("PASS: board sleep wake source, held button, LED retention, rejected entry and NVS failures");
#else
    assert(!board_power_supported() && !board_power_wake_released());
    assert(board_power_init() == ESP_ERR_NOT_SUPPORTED);
    assert(board_power_load_timeout(&timeout) == ESP_ERR_NOT_SUPPORTED && timeout == 99);
    assert(board_power_save_timeout(30) == ESP_ERR_NOT_SUPPORTED);
    assert(board_power_prepare_sleep() == ESP_ERR_NOT_SUPPORTED);
    assert(board_power_enter_sleep() == ESP_ERR_NOT_SUPPORTED);
    assert(board_power_cancel_sleep() == ESP_ERR_NOT_SUPPORTED);
    assert(hardware_calls == 0 && writes == 0 && sleep_calls == 0);
    puts("PASS: unsupported power management leaves hardware and storage untouched");
#endif
    return 0;
}
