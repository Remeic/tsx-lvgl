#pragma once

#include "esp_err.h"

#include "tsx_board_adapter.h"

#include <stddef.h>
#include <stdint.h>

typedef struct runtime_probe runtime_probe_t;

/** Mirrors RUNTIME_BUNDLE_MAX_BYTES in packages/runtime/src/bundle.ts. */
#define RUNTIME_BUNDLE_MAX_BYTES 262144U

/**
 * Identity constants the kernel's bundle policy checks against (see
 * `packages/device/src/kernel.ts` `policy()` and
 * `packages/bundler/src/index.ts` `PROTOCOL_VERSION`). The board identity is
 * supplied by the linked target adapter; the protocol version is shared by
 * the runtime and transport.
 */
#define RUNTIME_PROBE_PROTOCOL_VERSION 1

/** Target-owned embedded runtime files. The shared component only consumes the
 * opaque byte/string views; the target composition owns the filenames and
 * ESP-IDF embedding declarations. */
typedef struct {
    const uint8_t *kernel_start;
    const uint8_t *kernel_end;
    const char *app_source;
    const char *app_manifest;
} runtime_probe_assets_t;

esp_err_t runtime_probe_start(const tsx_board_adapter_t *board,
                              const runtime_probe_assets_t *assets,
                              runtime_probe_t **out_probe);
/**
 * Owns the complete owner-task lifecycle: transport, optional providers,
 * locked boot, owner loop, transport join, provider teardown and locked LVGL
 * destruction. The caller must be the target's single runtime owner task.
 *
 * Return contract: `ESP_ERR_TIMEOUT` is a named retry signal meaning
 * "LVGL-lock cleanup retained; the owner task must call again after a short
 * delay". Any other value is terminal for the current boot attempt.
 */
esp_err_t runtime_probe_run(const tsx_board_adapter_t *board,
                            const runtime_probe_assets_t *assets);
/** Starts the cached QMI provider outside the display/QuickJS owner lock. */
esp_err_t runtime_probe_start_sensors(runtime_probe_t *probe);
/** Starts the station provider before the kernel can expose `useWifi`. */
esp_err_t runtime_probe_start_connectivity(runtime_probe_t *probe);
/** Evaluates kernel/app only after providers are configured; caller owns LVGL lock. */
esp_err_t runtime_probe_boot(runtime_probe_t *probe);
void runtime_probe_task(void *arg);

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
const char *runtime_probe_target_id(runtime_probe_t *probe);
