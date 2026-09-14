#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define NETWORK_SCAN_LIMIT 12

typedef struct {
	char ssid[33];
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
	char requested_hostname[33];
	char ap_ssid[33];
	char saved_ssid[33];
	char station_ssid[33];
	char ap_ip[16];
	char station_ip[16];
	size_t scan_count;
	network_scan_item_t scan[NETWORK_SCAN_LIMIT];
} network_status_t;

esp_err_t network_start(void);
void network_status(network_status_t *status);
esp_err_t network_submit(const uint8_t *payload, size_t length, bool scan, uint32_t *job_id);
void network_management_touch(uint32_t local_address);
bool network_control_begin(uint32_t local_address, uint32_t generation);
void network_control_end(uint32_t generation);