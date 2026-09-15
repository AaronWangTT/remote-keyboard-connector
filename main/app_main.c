#include "esp_err.h"
#include "esp_log.h"
#include "network.h"
#include "usb_keyboard.h"
#include "web_server.h"

static const char *const TAG = "remote_keyboard";

void app_main(void)
{
    ESP_ERROR_CHECK(usb_keyboard_start());
    ESP_LOGI(TAG, "USB keyboard started; input is released");
    esp_err_t result = network_start();
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "Network unavailable (%s); keyboard remains disarmed. Check the preceding startup diagnostics.", esp_err_to_name(result));
        return;
    }
    result = web_server_start();
    if (result != ESP_OK) ESP_LOGE(TAG, "Web interface unavailable (%s); keyboard remains disarmed", esp_err_to_name(result));
}