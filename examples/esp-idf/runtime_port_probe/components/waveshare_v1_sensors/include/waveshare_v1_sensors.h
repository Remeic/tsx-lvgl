#pragma once
#include "driver/i2c_master.h"
#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>
typedef struct waveshare_v1_sensors waveshare_v1_sensors_t;
typedef struct { bool available; double acceleration_mps2[3]; double angular_velocity_dps[3]; int64_t observed_at_ms; uint32_t sequence; } waveshare_v1_motion_frame_t;
/** Creates the provider task; never call this while the LVGL lock is held. */
esp_err_t waveshare_v1_sensors_create(i2c_master_bus_handle_t bus, waveshare_v1_sensors_t **out_provider);
/** Stops and joins the provider task before releasing its I2C/mutex state. */
void waveshare_v1_sensors_destroy(waveshare_v1_sensors_t *provider);
/** Non-blocking cache copy for the QuickJS owner task; it performs no I2C. */
bool waveshare_v1_sensors_read_motion(waveshare_v1_sensors_t *provider, waveshare_v1_motion_frame_t *out_frame);
