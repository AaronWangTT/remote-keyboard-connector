#pragma once

#include "board_power_policy.h"
#include "esp_err.h"

bool board_power_supported(void);
esp_err_t board_power_init(void);
esp_err_t board_power_load_timeout(uint32_t *idle_minutes);
esp_err_t board_power_save_timeout(uint32_t idle_minutes);
bool board_power_wake_released(void);
esp_err_t board_power_prepare_sleep(void);
esp_err_t board_power_cancel_sleep(void);
esp_err_t board_power_enter_sleep(void);
