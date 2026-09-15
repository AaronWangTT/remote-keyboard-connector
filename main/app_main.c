#include "board_status.h"
#include "esp_err.h"
#include "esp_log.h"
#include "network.h"
#include "usb_keyboard.h"
#include "web_server.h"

static const char *const TAG = "remote_keyboard";

static board_status_snapshot_t board_status_source(void)
{
    web_server_status_t status = web_server_status();
    return (board_status_snapshot_t){
        .valid = status.valid,
        .ready = status.ready,
        .controller_active = status.controller_active,
        .sampled_at_ms = status.sampled_at_ms,
    };
}

void app_main(void)
{
    esp_err_t led_result = board_status_start(board_status_source);
    if (led_result != ESP_OK && led_result != ESP_ERR_NOT_SUPPORTED) {
        ESP_LOGW(TAG, "Board status LED unavailable (%s); keyboard startup continues", esp_err_to_name(led_result));
    }
    ESP_ERROR_CHECK(usb_keyboard_start());
    ESP_LOGI(TAG, "USB keyboard started; input is released");
    esp_err_t result = network_start();
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "Network unavailable (%s); keyboard remains disarmed. Check the preceding startup diagnostics.", esp_err_to_name(result));
        return;
    }
    result = web_server_start();
    if (result != ESP_OK) ESP_LOGE(TAG, "Web interface unavailable (%s); keyboard remains disarmed", esp_err_to_name(result));
    else if (led_result == ESP_OK) {
        result = web_server_status_start();
        if (result != ESP_OK) ESP_LOGW(TAG, "Board status publication unavailable (%s); keyboard service continues", esp_err_to_name(result));
    }
}