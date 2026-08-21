#pragma once

#include "esp_err.h"
#include "tsx_board_identity.h"

/** Starts the V1 SH8601 display and performs a bounded, fail-soft FT3168 setup. */
esp_err_t tsx_board_adapter_v1_display_start(void);

/** Probes V1/V2 touch addresses through the BSP-owned I2C bus without writes. */
esp_err_t tsx_board_adapter_v1_probe_identity(tsx_board_identity_t *out_identity);
