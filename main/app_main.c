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
    ESP_ERROR_CHECK(network_start());
    ESP_ERROR_CHECK(web_server_start());
}