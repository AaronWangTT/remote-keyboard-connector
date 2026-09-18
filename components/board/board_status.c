#include "board_status.h"
#include "sdkconfig.h"

#if CONFIG_BOARD_XINLUCITY_ESP32S3_NANO && CONFIG_IDF_TARGET_ESP32S3
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const gpio_num_t STATUS_GPIO = GPIO_NUM_48;
static board_status_source_t status_source;
static TaskHandle_t status_task;
static portMUX_TYPE output_lock = portMUX_INITIALIZER_UNLOCKED;
static bool output_paused;
static int previous_level = 1;

static void render_status(void *argument)
{
    (void)argument;
    board_status_pattern_t pattern = {0};
    for (;;) {
        board_status_snapshot_t snapshot = status_source();
        uint64_t now_ms = (uint64_t)(esp_timer_get_time() / 1000);
        board_status_t state = board_status_select(&snapshot, now_ms);
        int level = board_status_active_low_level(board_status_pattern_on(&pattern, state, now_ms));
        esp_err_t result = ESP_OK;
        portENTER_CRITICAL(&output_lock);
        if (!output_paused && level != previous_level) {
            result = gpio_set_level(STATUS_GPIO, level);
            if (result == ESP_OK) previous_level = level;
        }
        portEXIT_CRITICAL(&output_lock);
        if (result != ESP_OK) {
            ESP_LOGW("board", "G48 update failed (%s); disabling status LED", esp_err_to_name(result));
            result = board_status_pause(true);
            if (result != ESP_OK) ESP_LOGW("board", "Could not leave G48 inactive (%s)", esp_err_to_name(result));
            vTaskDelete(NULL);
            return;
        }
        vTaskDelay(pdMS_TO_TICKS(BOARD_STATUS_REFRESH_MS) > 0 ? pdMS_TO_TICKS(BOARD_STATUS_REFRESH_MS) : 1);
    }
}

esp_err_t board_status_pause(bool paused)
{
    if (status_task == NULL) return ESP_ERR_INVALID_STATE;
    portENTER_CRITICAL(&output_lock);
    output_paused = paused;
    esp_err_t result = paused ? gpio_set_level(STATUS_GPIO, 1) : ESP_OK;
    if (paused && result == ESP_OK) previous_level = 1;
    portEXIT_CRITICAL(&output_lock);
    return result;
}

esp_err_t board_status_start(board_status_source_t source)
{
    if (source == NULL) return ESP_ERR_INVALID_ARG;
    if (status_task != NULL) return ESP_ERR_INVALID_STATE;
    esp_err_t result = gpio_set_level(STATUS_GPIO, board_status_active_low_level(false));
    if (result != ESP_OK) return result;
    const gpio_config_t configuration = {
        .pin_bit_mask = UINT64_C(1) << STATUS_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    result = gpio_config(&configuration);
    if (result != ESP_OK) return result;
#if CONFIG_BOARD_POWER_MANAGEMENT
    gpio_deep_sleep_hold_dis();
    result = gpio_hold_dis(STATUS_GPIO);
    if (result != ESP_OK) return result;
#endif
    status_source = source;
    return xTaskCreate(render_status, "board_status", 2048, NULL, tskIDLE_PRIORITY + 1, &status_task) == pdPASS ?
        ESP_OK : ESP_ERR_NO_MEM;
}
#else
esp_err_t board_status_pause(bool paused)
{
    (void)paused;
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t board_status_start(board_status_source_t source)
{
    (void)source;
    return ESP_ERR_NOT_SUPPORTED;
}
#endif