#pragma once

#include <stddef.h>
#include "board_power_policy.h"
#include "esp_err.h"

typedef struct {
    bool supported;
    bool available;
    bool preparing;
    uint32_t idle_minutes;
    const char *error;
} power_control_status_t;

void power_control_init(void);
power_control_status_t power_control_status(void);
void power_control_activity(void);
esp_err_t power_control_configure(uint32_t idle_minutes);
bool power_control_parse_request(const uint8_t *payload, size_t length, uint32_t *idle_minutes);
void power_control_poll(bool owner_ready, bool pending_control, void (*release_control)(void));
