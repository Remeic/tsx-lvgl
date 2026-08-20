#pragma once

#include "esp_err.h"

#include <stdbool.h>
#include <stdint.h>

/*
 * This header is the only native contract shared by the ESP-IDF runtime and a
 * target adapter. Contexts and provider handles remain opaque: a target can
 * keep BSP handles, queues, tasks, and platform state private to its adapter.
 */

typedef struct tsx_motion_provider tsx_motion_provider_t;
typedef struct tsx_wifi_provider tsx_wifi_provider_t;

typedef struct {
    bool available;
    double acceleration_mps2[3];
    double angular_velocity_dps[3];
    int64_t observed_at_ms;
    uint32_t sequence;
} tsx_motion_frame_t;

#define TSX_MOTION_MIN_PERIOD_MS 20U
#define TSX_MOTION_MAX_PERIOD_MS 1000U

typedef enum {
    TSX_WIFI_PHASE_DISABLED,
    TSX_WIFI_PHASE_IDLE,
    TSX_WIFI_PHASE_CONNECTING,
    TSX_WIFI_PHASE_CONNECTED,
} tsx_wifi_phase_t;

typedef enum {
    TSX_WIFI_COMMAND_SCAN,
    TSX_WIFI_COMMAND_CONNECT,
    TSX_WIFI_COMMAND_DISCONNECT,
} tsx_wifi_command_t;

typedef enum {
    TSX_WIFI_EVENT_STATE,
    TSX_WIFI_EVENT_SUCCEEDED,
    TSX_WIFI_EVENT_FAILED,
} tsx_wifi_event_kind_t;

/**
 * Plan 003 migration-only result. This records that the linked target was
 * accepted from compile-time composition; it is not an observed hardware
 * identity. Plan 004 will extend this seam with matched, mismatched and
 * unknown results.
 */
typedef enum {
    TSX_BOARD_IDENTITY_COMPILE_TIME_ACCEPTED,
} tsx_board_identity_result_t;

/** Sanitised owner-queue event. It contains no network identity or address. */
typedef struct {
    tsx_wifi_event_kind_t kind;
    tsx_wifi_phase_t phase;
    tsx_wifi_command_t command;
    uint32_t correlation_id;
    uint32_t sequence;
    int8_t rssi_dbm;
    uint8_t channel;
    uint8_t auth_kind;
    const char *diagnostic_id;
} tsx_wifi_event_t;

typedef struct {
    void *context;
    /** Returns the generated canonical target ID owned by the target build. */
    const char *(*target_id)(void *context);
    /** Starts the target display and its fail-soft input capability. */
    esp_err_t (*display_start)(void *context);
    /** Takes the target display/LVGL lock. All LVGL calls use this gateway. */
    bool (*display_lock)(void *context, uint32_t timeout_ms);
    /** Releases the target display/LVGL lock. */
    void (*display_unlock)(void *context);
    /**
     * Returns a typed migration result. ESP_OK means the result was retrieved;
     * the result itself is never an observed-match or readiness signal.
     */
    esp_err_t (*probe_identity)(void *context, tsx_board_identity_result_t *out_result);
} tsx_board_boot_port_t;

typedef struct {
    void *context;
    esp_err_t (*create)(void *context, tsx_motion_provider_t **out_provider);
    void (*destroy)(void *context, tsx_motion_provider_t *provider);
    bool (*read)(void *context, tsx_motion_provider_t *provider, tsx_motion_frame_t *out_frame);
    esp_err_t (*set_period_ms)(void *context, tsx_motion_provider_t *provider, uint32_t period_ms);
} tsx_motion_port_t;

typedef struct {
    void *context;
    esp_err_t (*create)(void *context, tsx_wifi_provider_t **out_provider);
    void (*destroy)(void *context, tsx_wifi_provider_t *provider);
    esp_err_t (*submit)(void *context, tsx_wifi_provider_t *provider,
                        tsx_wifi_command_t command, uint32_t correlation_id);
    void (*cancel)(void *context, tsx_wifi_provider_t *provider, uint32_t correlation_id);
    bool (*take_event)(void *context, tsx_wifi_provider_t *provider, tsx_wifi_event_t *out_event);
    tsx_wifi_event_t (*state)(void *context, tsx_wifi_provider_t *provider);
} tsx_wifi_port_t;

typedef struct tsx_board_adapter {
    const tsx_board_boot_port_t *boot;
    const tsx_motion_port_t *motion;
    const tsx_wifi_port_t *wifi;
} tsx_board_adapter_t;

static inline const char *tsx_board_adapter_target_id(const tsx_board_adapter_t *adapter)
{
    return adapter != NULL && adapter->boot != NULL && adapter->boot->target_id != NULL
               ? adapter->boot->target_id(adapter->boot->context)
               : NULL;
}

static inline esp_err_t tsx_board_adapter_display_start(const tsx_board_adapter_t *adapter)
{
    return adapter != NULL && adapter->boot != NULL && adapter->boot->display_start != NULL
               ? adapter->boot->display_start(adapter->boot->context)
               : ESP_ERR_INVALID_STATE;
}

static inline bool tsx_board_adapter_display_lock(const tsx_board_adapter_t *adapter, uint32_t timeout_ms)
{
    return adapter != NULL && adapter->boot != NULL && adapter->boot->display_lock != NULL
               ? adapter->boot->display_lock(adapter->boot->context, timeout_ms)
               : false;
}

static inline void tsx_board_adapter_display_unlock(const tsx_board_adapter_t *adapter)
{
    if (adapter != NULL && adapter->boot != NULL && adapter->boot->display_unlock != NULL) {
        adapter->boot->display_unlock(adapter->boot->context);
    }
}

static inline esp_err_t tsx_board_adapter_probe_identity(const tsx_board_adapter_t *adapter,
                                                          tsx_board_identity_result_t *out_result)
{
    if (out_result == NULL) return ESP_ERR_INVALID_ARG;
    if (adapter == NULL || adapter->boot == NULL || adapter->boot->probe_identity == NULL) {
        return ESP_ERR_NOT_SUPPORTED;
    }
    return adapter->boot->probe_identity(adapter->boot->context, out_result);
}
