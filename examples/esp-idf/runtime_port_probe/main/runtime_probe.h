#pragma once

#include "esp_err.h"

#include <stdint.h>

typedef struct runtime_probe runtime_probe_t;

/** Mirrors RUNTIME_BUNDLE_MAX_BYTES in packages/runtime/src/bundle.ts. */
#define RUNTIME_BUNDLE_MAX_BYTES 262144U

/**
 * Identity constants the kernel's bundle policy checks against (see
 * `packages/device/src/kernel.ts` `policy()` and
 * `packages/bundler/src/index.ts` `BOARD_ID`/`PROTOCOL_VERSION`). Centralized
 * here so `runtime_probe.c` (which installs `__native.boardId`) and
 * `bundle_transport.c` (which reports both in the `TSXB RDY` reply) share one
 * definition.
 */
#define RUNTIME_PROBE_BOARD_ID "waveshare.esp32s3.touch-amoled-1.8"
#define RUNTIME_PROBE_PROTOCOL_VERSION 1

esp_err_t runtime_probe_start(runtime_probe_t **out_probe);
/** Starts the cached QMI provider outside the display/QuickJS owner lock. */
esp_err_t runtime_probe_start_sensors(runtime_probe_t *probe);
/** Starts the station provider before the kernel can expose `useWifi`. */
esp_err_t runtime_probe_start_connectivity(runtime_probe_t *probe);
/** Evaluates kernel/app only after providers are configured; caller owns LVGL lock. */
esp_err_t runtime_probe_boot(runtime_probe_t *probe);
void runtime_probe_task(void *arg);
void runtime_probe_destroy(runtime_probe_t *probe);

typedef enum {
    RUNTIME_PROBE_RELOAD_COMMITTED,
    RUNTIME_PROBE_RELOAD_ROLLED_BACK,
    RUNTIME_PROBE_RELOAD_REJECTED,
    /** The owner task did not process the request within the caller's timeout. */
    RUNTIME_PROBE_RELOAD_TIMEOUT,
} runtime_probe_reload_kind_t;

typedef struct {
    runtime_probe_reload_kind_t kind;
    /** Valid when kind == RUNTIME_PROBE_RELOAD_COMMITTED. */
    uint32_t epoch;
    /** Valid when kind == RUNTIME_PROBE_RELOAD_REJECTED (a RuntimeBundleRejection
     *  reason or "malformed-manifest"/"non-ascii"), or "timeout" for RUNTIME_PROBE_RELOAD_TIMEOUT. */
    char reason[64];
} runtime_probe_reload_result_t;

/**
 * Called only from the bundle transport task, at most once per accepted
 * transfer (the wire protocol serializes attempts; see
 * docs/feature-specs/0010-runtime-tsx-hot-reload.md). Hands `manifest_json`
 * and `source_text` (both NUL-terminated, owned by the caller) to the owner
 * task. The handoff makes bounded copies before enqueueing, so a timeout
 * cannot leave the owner task holding a pointer into a transport stack frame
 * or a staging buffer that the transport has already released. The owner
 * processes the copies at its next quiescent point (`__tsxKernelReload`, under
 * the display lock) and reports the result back here. Blocks up to
 * `timeout_ms`; a timed-out request remains serialized until the owner has
 * completed it.
 */
runtime_probe_reload_result_t runtime_probe_stage_reload(runtime_probe_t *probe,
                                                           const char *manifest_json,
                                                           const char *source_text,
                                                           uint32_t timeout_ms);

/** Cached `__tsxKernelLastGeneration()`, refreshed after boot and after each processed reload. Safe from any task. */
uint32_t runtime_probe_last_generation(runtime_probe_t *probe);
