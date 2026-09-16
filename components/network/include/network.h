#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define NETWORK_SCAN_LIMIT 12
#define NETWORK_SCAN_SSID_DISPLAY_MAX 128
#define NETWORK_SCAN_SSID_HEX_MAX 64

typedef struct {
	char ssid[NETWORK_SCAN_SSID_DISPLAY_MAX + 1];
	char ssid_hex[NETWORK_SCAN_SSID_HEX_MAX + 1];
	int rssi;
	bool supported;
} network_scan_item_t;

typedef struct {
	bool available;
	bool ap_active;
	bool station_online;
	bool desired_station;
	bool has_profile;
	bool busy;
	bool mdns;
	bool can_control;
	uint32_t job_id;
	char phase[24];
	char job[24];
	char error[40];
	char hostname[65];
	char previous_hostname[65];
	char requested_hostname[33];
	char ap_ssid[33];
	char saved_ssid[NETWORK_SCAN_SSID_DISPLAY_MAX + 1];
	char saved_ssid_hex[NETWORK_SCAN_SSID_HEX_MAX + 1];
	char station_ssid[NETWORK_SCAN_SSID_DISPLAY_MAX + 1];
	char ap_ip[16];
	char ap_reconnect_ip[16];
	char station_ip[16];
	size_t scan_count;
	network_scan_item_t scan[NETWORK_SCAN_LIMIT];
} network_status_t;

typedef struct {
	bool ready;
	bool controller_path_ready;
} network_control_status_t;

esp_err_t network_start(void);
void network_status(network_status_t *status);
network_control_status_t network_control_status(uint32_t generation);
esp_err_t network_submit(const uint8_t *payload, size_t length, bool scan, uint32_t *job_id);
void network_management_touch(uint32_t local_address);
bool network_control_begin(uint32_t local_address, uint32_t generation);
void network_control_end(uint32_t generation);
bool network_update_begin(uint32_t local_address);
void network_update_end(void);
bool network_service_healthy(void);