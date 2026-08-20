#include "tsx_board_adapter_v1.h"

#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "display_startup.h"
#include "tsx_board_target_id.h"
#include "waveshare_v1_sensors.h"
#include "waveshare_v1_wifi.h"

#include <stddef.h>
#include <stdlib.h>

struct tsx_motion_provider {
    waveshare_v1_sensors_t *impl;
};

struct tsx_wifi_provider {
    waveshare_v1_wifi_t *impl;
};

static const char *v1_target_id(void *context)
{
    (void)context;
    return TSX_BOARD_TARGET_ID;
}

static esp_err_t v1_display_start(void *context)
{
    (void)context;
    return tsx_board_adapter_v1_display_start();
}

static bool v1_display_lock(void *context, uint32_t timeout_ms)
{
    (void)context;
    return bsp_display_lock(timeout_ms);
}

static void v1_display_unlock(void *context)
{
    (void)context;
    bsp_display_unlock();
}

/* Plan 004 owns physical identity probing. V1 remains compile-time accepted. */
static esp_err_t v1_probe_identity(void *context)
{
    (void)context;
    return ESP_OK;
}

static esp_err_t v1_motion_create(void *context, tsx_motion_provider_t **out_provider)
{
    (void)context;
    if (out_provider == NULL) return ESP_ERR_INVALID_ARG;
    *out_provider = NULL;
    tsx_motion_provider_t *provider = calloc(1, sizeof(*provider));
    if (provider == NULL) return ESP_ERR_NO_MEM;
    const esp_err_t result = waveshare_v1_sensors_create(bsp_i2c_get_handle(), &provider->impl);
    if (result != ESP_OK) {
        free(provider);
        return result;
    }
    *out_provider = provider;
    return ESP_OK;
}

static void v1_motion_destroy(void *context, tsx_motion_provider_t *provider)
{
    (void)context;
    if (provider == NULL) return;
    waveshare_v1_sensors_destroy(provider->impl);
    free(provider);
}

static bool v1_motion_read(void *context, tsx_motion_provider_t *provider, tsx_motion_frame_t *out_frame)
{
    (void)context;
    if (provider == NULL || provider->impl == NULL || out_frame == NULL) return false;
    waveshare_v1_motion_frame_t frame = {0};
    if (!waveshare_v1_sensors_read_motion(provider->impl, &frame)) return false;
    out_frame->available = frame.available;
    for (size_t index = 0; index < 3U; index++) {
        out_frame->acceleration_mps2[index] = frame.acceleration_mps2[index];
        out_frame->angular_velocity_dps[index] = frame.angular_velocity_dps[index];
    }
    out_frame->observed_at_ms = frame.observed_at_ms;
    out_frame->sequence = frame.sequence;
    return true;
}

static esp_err_t v1_motion_set_period_ms(void *context, tsx_motion_provider_t *provider, uint32_t period_ms)
{
    (void)context;
    return provider == NULL || provider->impl == NULL
               ? ESP_ERR_INVALID_STATE
               : waveshare_v1_sensors_set_period_ms(provider->impl, period_ms);
}

static waveshare_v1_wifi_command_t to_v1_wifi_command(tsx_wifi_command_t command)
{
    switch (command) {
        case TSX_WIFI_COMMAND_CONNECT: return WAVESHARE_V1_WIFI_CONNECT;
        case TSX_WIFI_COMMAND_DISCONNECT: return WAVESHARE_V1_WIFI_DISCONNECT;
        case TSX_WIFI_COMMAND_SCAN: return WAVESHARE_V1_WIFI_SCAN;
    }
    return WAVESHARE_V1_WIFI_SCAN;
}

static tsx_wifi_phase_t to_tsx_wifi_phase(waveshare_v1_wifi_phase_t phase)
{
    switch (phase) {
        case WAVESHARE_V1_WIFI_IDLE: return TSX_WIFI_PHASE_IDLE;
        case WAVESHARE_V1_WIFI_CONNECTING: return TSX_WIFI_PHASE_CONNECTING;
        case WAVESHARE_V1_WIFI_CONNECTED: return TSX_WIFI_PHASE_CONNECTED;
        case WAVESHARE_V1_WIFI_DISABLED: return TSX_WIFI_PHASE_DISABLED;
    }
    return TSX_WIFI_PHASE_DISABLED;
}

static tsx_wifi_event_kind_t to_tsx_wifi_event_kind(waveshare_v1_wifi_event_kind_t kind)
{
    switch (kind) {
        case WAVESHARE_V1_WIFI_EVENT_STATE: return TSX_WIFI_EVENT_STATE;
        case WAVESHARE_V1_WIFI_EVENT_SUCCEEDED: return TSX_WIFI_EVENT_SUCCEEDED;
        case WAVESHARE_V1_WIFI_EVENT_FAILED: return TSX_WIFI_EVENT_FAILED;
    }
    return TSX_WIFI_EVENT_FAILED;
}

static tsx_wifi_command_t to_tsx_wifi_command(waveshare_v1_wifi_command_t command)
{
    switch (command) {
        case WAVESHARE_V1_WIFI_CONNECT: return TSX_WIFI_COMMAND_CONNECT;
        case WAVESHARE_V1_WIFI_DISCONNECT: return TSX_WIFI_COMMAND_DISCONNECT;
        case WAVESHARE_V1_WIFI_SCAN: return TSX_WIFI_COMMAND_SCAN;
    }
    return TSX_WIFI_COMMAND_SCAN;
}

static tsx_wifi_event_t to_tsx_wifi_event(waveshare_v1_wifi_event_t event)
{
    return (tsx_wifi_event_t) {
        .kind = to_tsx_wifi_event_kind(event.kind),
        .phase = to_tsx_wifi_phase(event.phase),
        .command = to_tsx_wifi_command(event.command),
        .correlation_id = event.correlation_id,
        .sequence = event.sequence,
        .rssi_dbm = event.rssi_dbm,
        .channel = event.channel,
        .auth_kind = event.auth_kind,
        .diagnostic_id = event.diagnostic_id,
    };
}

static esp_err_t v1_wifi_create(void *context, tsx_wifi_provider_t **out_provider)
{
    (void)context;
    if (out_provider == NULL) return ESP_ERR_INVALID_ARG;
    *out_provider = NULL;
    tsx_wifi_provider_t *provider = calloc(1, sizeof(*provider));
    if (provider == NULL) return ESP_ERR_NO_MEM;
    const esp_err_t result = waveshare_v1_wifi_create(&provider->impl);
    if (result != ESP_OK) {
        free(provider);
        return result;
    }
    *out_provider = provider;
    return ESP_OK;
}

static void v1_wifi_destroy(void *context, tsx_wifi_provider_t *provider)
{
    (void)context;
    if (provider == NULL) return;
    waveshare_v1_wifi_destroy(provider->impl);
    free(provider);
}

static esp_err_t v1_wifi_submit(void *context, tsx_wifi_provider_t *provider,
                                tsx_wifi_command_t command, uint32_t correlation_id)
{
    (void)context;
    return provider == NULL || provider->impl == NULL
               ? ESP_ERR_INVALID_STATE
               : waveshare_v1_wifi_submit(provider->impl, to_v1_wifi_command(command), correlation_id);
}

static void v1_wifi_cancel(void *context, tsx_wifi_provider_t *provider, uint32_t correlation_id)
{
    (void)context;
    if (provider != NULL && provider->impl != NULL) waveshare_v1_wifi_cancel(provider->impl, correlation_id);
}

static bool v1_wifi_take_event(void *context, tsx_wifi_provider_t *provider, tsx_wifi_event_t *out_event)
{
    (void)context;
    if (provider == NULL || provider->impl == NULL || out_event == NULL) return false;
    waveshare_v1_wifi_event_t event = {0};
    if (!waveshare_v1_wifi_take_event(provider->impl, &event)) return false;
    *out_event = to_tsx_wifi_event(event);
    return true;
}

static tsx_wifi_event_t v1_wifi_state(void *context, tsx_wifi_provider_t *provider)
{
    (void)context;
    if (provider == NULL || provider->impl == NULL) {
        return (tsx_wifi_event_t) {.kind = TSX_WIFI_EVENT_STATE, .phase = TSX_WIFI_PHASE_DISABLED,
                                   .command = TSX_WIFI_COMMAND_SCAN, .rssi_dbm = -127, .channel = 1, .auth_kind = 5};
    }
    return to_tsx_wifi_event(waveshare_v1_wifi_state(provider->impl));
}

static const tsx_board_boot_port_t V1_BOOT_PORT = {
    .context = NULL,
    .target_id = v1_target_id,
    .display_start = v1_display_start,
    .display_lock = v1_display_lock,
    .display_unlock = v1_display_unlock,
    .probe_identity = v1_probe_identity,
};

static const tsx_motion_port_t V1_MOTION_PORT = {
    .context = NULL,
    .create = v1_motion_create,
    .destroy = v1_motion_destroy,
    .read = v1_motion_read,
    .set_period_ms = v1_motion_set_period_ms,
};

static const tsx_wifi_port_t V1_WIFI_PORT = {
    .context = NULL,
    .create = v1_wifi_create,
    .destroy = v1_wifi_destroy,
    .submit = v1_wifi_submit,
    .cancel = v1_wifi_cancel,
    .take_event = v1_wifi_take_event,
    .state = v1_wifi_state,
};

const tsx_board_adapter_t *tsx_board_adapter_v1(void)
{
    static const tsx_board_adapter_t adapter = {
        .boot = &V1_BOOT_PORT,
        .motion = &V1_MOTION_PORT,
        .wifi = &V1_WIFI_PORT,
    };
    return &adapter;
}
