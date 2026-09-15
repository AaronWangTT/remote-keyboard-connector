#pragma once

#include "board_status_logic.h"
#include "esp_err.h"

typedef board_status_snapshot_t (*board_status_source_t)(void);

esp_err_t board_status_start(board_status_source_t source);