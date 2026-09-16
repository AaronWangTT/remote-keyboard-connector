#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

typedef struct {
	bool valid;
	bool ready;
	bool controller_active;
	uint64_t sampled_at_ms;
} web_server_status_t;

esp_err_t web_server_start(void);
esp_err_t web_server_status_start(void);
web_server_status_t web_server_status(void);
bool web_server_service_healthy(void);