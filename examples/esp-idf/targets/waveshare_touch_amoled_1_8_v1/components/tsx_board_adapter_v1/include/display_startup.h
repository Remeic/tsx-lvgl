#pragma once

#include "esp_err.h"

/** Starts the V1 SH8601 display and performs a bounded, fail-soft FT3168 setup. */
esp_err_t tsx_board_adapter_v1_display_start(void);
