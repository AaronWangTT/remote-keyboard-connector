#include "board_power.h"
#include "sdkconfig.h"

#if CONFIG_BOARD_POWER_MANAGEMENT && CONFIG_BOARD_XINLUCITY_ESP32S3_NANO && CONFIG_IDF_TARGET_ESP32S3
#include "board_status.h"
#include "driver/gpio.h"
#include "driver/rtc_io.h"
#include "esp_sleep.h"
#include "nvs.h"

static bool initialized;
static bool wake_prepared;

bool board_power_supported(void)
{
    return true;
}

esp_err_t board_power_init(void)
{
    const gpio_config_t configuration = {
        .pin_bit_mask = UINT64_C(1) << GPIO_NUM_0,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t result = rtc_gpio_hold_dis(GPIO_NUM_0);
    if (result == ESP_OK) result = rtc_gpio_deinit(GPIO_NUM_0);
    if (result == ESP_OK) result = gpio_config(&configuration);
    initialized = result == ESP_OK;
    return result;
}

esp_err_t board_power_load_timeout(uint32_t *idle_minutes)
{
    if (!initialized || idle_minutes == NULL) return ESP_ERR_INVALID_STATE;
    *idle_minutes = BOARD_POWER_DEFAULT_IDLE_MINUTES;
    nvs_handle_t handle;
    esp_err_t result = nvs_open("board_power", NVS_READONLY, &handle);
    if (result == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (result != ESP_OK) return result;
    uint32_t saved_minutes = 0;
    result = nvs_get_u32(handle, "idle_minutes", &saved_minutes);
    nvs_close(handle);
    if (result == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (result != ESP_OK) return result;
    if (!board_power_timeout_valid(saved_minutes)) return ESP_ERR_INVALID_STATE;
    *idle_minutes = saved_minutes;
    return ESP_OK;
}

esp_err_t board_power_save_timeout(uint32_t idle_minutes)
{
    if (!initialized) return ESP_ERR_INVALID_STATE;
    if (!board_power_timeout_valid(idle_minutes)) return ESP_ERR_INVALID_ARG;
    nvs_handle_t handle;
    esp_err_t result = nvs_open("board_power", NVS_READWRITE, &handle);
    if (result != ESP_OK) return result;
    result = nvs_set_u32(handle, "idle_minutes", idle_minutes);
    if (result == ESP_OK) result = nvs_commit(handle);
    nvs_close(handle);
    return result;
}

bool board_power_wake_released(void)
{
    return initialized && gpio_get_level(GPIO_NUM_0) != 0;
}

esp_err_t board_power_prepare_sleep(void)
{
    if (!board_power_wake_released()) return ESP_ERR_INVALID_STATE;
    esp_err_t result = esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
    if (result == ESP_OK) result = rtc_gpio_pullup_en(GPIO_NUM_0);
    if (result == ESP_OK) result = rtc_gpio_pulldown_dis(GPIO_NUM_0);
    if (result == ESP_OK) result = esp_sleep_enable_ext1_wakeup_io(UINT64_C(1) << GPIO_NUM_0, ESP_EXT1_WAKEUP_ANY_LOW);
    wake_prepared = result == ESP_OK;
    return result;
}

esp_err_t board_power_cancel_sleep(void)
{
    if (!initialized) return ESP_ERR_INVALID_STATE;
    wake_prepared = false;
    esp_err_t result = esp_sleep_disable_ext1_wakeup_io(UINT64_C(1) << GPIO_NUM_0);
    esp_err_t restored = board_power_init();
    return result != ESP_OK ? result : restored;
}

esp_err_t board_power_enter_sleep(void)
{
    if (!wake_prepared || !board_power_wake_released()) return ESP_ERR_INVALID_STATE;
    esp_err_t result = board_status_pause(true);
    const gpio_config_t inactive = {
        .pin_bit_mask = UINT64_C(1) << GPIO_NUM_48,
        .mode = GPIO_MODE_DISABLE,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    if (result == ESP_OK) result = gpio_config(&inactive);
    if (result == ESP_OK) result = gpio_hold_en(GPIO_NUM_48);
    if (result == ESP_OK) {
        gpio_deep_sleep_hold_en();
        result = esp_deep_sleep_try_to_start();
        gpio_deep_sleep_hold_dis();
    }
    esp_err_t restored = gpio_set_level(GPIO_NUM_48, 1);
    gpio_config_t active = inactive;
    active.mode = GPIO_MODE_OUTPUT;
    esp_err_t configured = gpio_config(&active);
    if (restored == ESP_OK) restored = configured;
    esp_err_t released = gpio_hold_dis(GPIO_NUM_48);
    if (restored == ESP_OK) restored = released;
    esp_err_t resumed = board_status_pause(false);
    if (restored == ESP_OK) restored = resumed;
    return restored != ESP_OK ? restored : result == ESP_OK ? ESP_FAIL : result;
}
#else
bool board_power_supported(void) { return false; }
esp_err_t board_power_init(void) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t board_power_load_timeout(uint32_t *idle_minutes) { (void)idle_minutes; return ESP_ERR_NOT_SUPPORTED; }
esp_err_t board_power_save_timeout(uint32_t idle_minutes) { (void)idle_minutes; return ESP_ERR_NOT_SUPPORTED; }
bool board_power_wake_released(void) { return false; }
esp_err_t board_power_prepare_sleep(void) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t board_power_cancel_sleep(void) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t board_power_enter_sleep(void) { return ESP_ERR_NOT_SUPPORTED; }
#endif
