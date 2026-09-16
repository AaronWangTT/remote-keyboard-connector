#pragma once

#include "update_policy.h"
#include "esp_err.h"

const update_descriptor_t *firmware_update_descriptor(void);

typedef struct {
	update_policy_t policy;
	bool available;
	bool busy;
	bool trial_boot;
	char candidate_version[32];
	char digest[65];
	char error[48];
} firmware_update_status_t;

esp_err_t firmware_update_init(void);
esp_err_t firmware_update_validate_boot(bool (*healthy)(void));
firmware_update_status_t firmware_update_status(void);
esp_err_t firmware_update_reserve(size_t bytes, uint32_t local_address, uint32_t *job_id);
esp_err_t firmware_update_open(uint32_t job_id);
esp_err_t firmware_update_write(uint32_t job_id, const uint8_t *data, size_t bytes);
esp_err_t firmware_update_finish(uint32_t job_id);
void firmware_update_worker_done(uint32_t job_id);
void firmware_update_fail(uint32_t job_id, const char *error);
bool firmware_update_cancel(uint32_t job_id);
void firmware_update_tick(void);
esp_err_t firmware_update_activate(uint32_t job_id, const char *digest);
void firmware_update_restart(void);