#pragma once

#include "esp_err.h"

#include <stdbool.h>
#include <stdint.h>

typedef struct waveshare_v1_wifi waveshare_v1_wifi_t;

typedef enum {
    WAVESHARE_V1_WIFI_DISABLED,
    WAVESHARE_V1_WIFI_IDLE,
    WAVESHARE_V1_WIFI_CONNECTING,
    WAVESHARE_V1_WIFI_CONNECTED,
} waveshare_v1_wifi_phase_t;

typedef enum {
    WAVESHARE_V1_WIFI_SCAN,
    WAVESHARE_V1_WIFI_CONNECT,
    WAVESHARE_V1_WIFI_DISCONNECT,
} waveshare_v1_wifi_command_t;

typedef enum {
    WAVESHARE_V1_WIFI_EVENT_STATE,
    WAVESHARE_V1_WIFI_EVENT_SUCCEEDED,
    WAVESHARE_V1_WIFI_EVENT_FAILED,
} waveshare_v1_wifi_event_kind_t;

/** Sanitised owner-queue event. It deliberately has no network identity or address fields. */
typedef struct {
    waveshare_v1_wifi_event_kind_t kind;
    waveshare_v1_wifi_phase_t phase;
    waveshare_v1_wifi_command_t command;
    uint32_t correlation_id;
    uint32_t sequence;
    int8_t rssi_dbm;
    uint8_t channel;
    uint8_t auth_kind;
    const char *diagnostic_id;
} waveshare_v1_wifi_event_t;

esp_err_t waveshare_v1_wifi_create(waveshare_v1_wifi_t **out_wifi);
void waveshare_v1_wifi_destroy(waveshare_v1_wifi_t *wifi);
esp_err_t waveshare_v1_wifi_submit(waveshare_v1_wifi_t *wifi, waveshare_v1_wifi_command_t command,
                                   uint32_t correlation_id);
void waveshare_v1_wifi_cancel(waveshare_v1_wifi_t *wifi, uint32_t correlation_id);
bool waveshare_v1_wifi_take_event(waveshare_v1_wifi_t *wifi, waveshare_v1_wifi_event_t *out_event);
waveshare_v1_wifi_event_t waveshare_v1_wifi_state(waveshare_v1_wifi_t *wifi);
