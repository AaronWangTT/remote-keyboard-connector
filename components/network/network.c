#include "network.h"

#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "lwip/ip4_addr.h"
#include "nvs_flash.h"
#include "usb_keyboard.h"

static const char *const TAG = "network";

_Static_assert(sizeof(CONFIG_MINIMAL_AP_PASSWORD) >= 9 &&
               sizeof(CONFIG_MINIMAL_AP_PASSWORD) <= 64,
               "Development AP password must contain 8 to 63 characters");

static void wifi_event(void *argument, esp_event_base_t event_base,
                       int32_t event_id, void *event_data)
{
    (void)argument;
    (void)event_base;
    (void)event_data;
    if (event_id == WIFI_EVENT_AP_STADISCONNECTED) {
        usb_keyboard_release(usb_keyboard_status().generation);
        ESP_LOGI(TAG, "Controller left the AP; input released");
    }
}

esp_err_t network_start(void)
{
    ESP_RETURN_ON_ERROR(nvs_flash_init(), TAG, "NVS initialization failed; no erase attempted");
    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "Network initialization failed");
    ESP_RETURN_ON_ERROR(esp_event_loop_create_default(), TAG, "Event loop initialization failed");
    esp_netif_t *access_point = esp_netif_create_default_wifi_ap();
    ESP_RETURN_ON_FALSE(access_point != NULL, ESP_ERR_NO_MEM, TAG, "AP interface allocation failed");

    esp_netif_ip_info_t address = {0};
    IP4_ADDR(&address.ip, 192, 168, 4, 1);
    IP4_ADDR(&address.gw, 192, 168, 4, 1);
    IP4_ADDR(&address.netmask, 255, 255, 255, 0);
    ESP_RETURN_ON_ERROR(esp_netif_dhcps_stop(access_point), TAG, "DHCP stop failed");
    ESP_RETURN_ON_ERROR(esp_netif_set_ip_info(access_point, &address), TAG, "AP address setup failed");
    ESP_RETURN_ON_ERROR(esp_netif_dhcps_start(access_point), TAG, "DHCP start failed");

    wifi_init_config_t initialization = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&initialization), TAG, "Wi-Fi initialization failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "Wi-Fi storage setup failed");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_AP_STADISCONNECTED,
                                                  wifi_event, NULL), TAG, "Wi-Fi event registration failed");

    uint8_t device_mac[6];
    ESP_RETURN_ON_ERROR(esp_wifi_get_mac(WIFI_IF_AP, device_mac), TAG, "AP identity unavailable");
    wifi_config_t configuration = {
        .ap = {
            .password = CONFIG_MINIMAL_AP_PASSWORD,
            .channel = 1,
            .authmode = WIFI_AUTH_WPA2_PSK,
            .max_connection = 1,
        },
    };
    configuration.ap.ssid_len = snprintf((char *)configuration.ap.ssid, sizeof(configuration.ap.ssid),
                                         "WiFiKeyboard-%02X%02X%02X",
                                         device_mac[3], device_mac[4], device_mac[5]);
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_AP), TAG, "AP mode setup failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_AP, &configuration), TAG, "AP configuration failed");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "AP startup failed");
    ESP_LOGW(TAG, "Unauthenticated development prototype; use an isolated test host only");
    ESP_LOGI(TAG, "AP %s at http://192.168.4.1/", configuration.ap.ssid);
    return ESP_OK;
}