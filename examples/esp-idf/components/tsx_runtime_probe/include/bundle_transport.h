#pragma once

#include "esp_err.h"

#include "runtime_probe.h"

/**
 * Starts the bundle transport task: reads "Bundle transport v1 (dev only)"
 * frames (docs/feature-specs/0010-runtime-tsx-hot-reload.md) off the USB
 * Serial/JTAG console and stages/hands off complete, verified bundles to
 * `probe` via `runtime_probe_stage_reload`. Never touches LVGL or the JS
 * engine directly, and never writes to flash.
 */
esp_err_t bundle_transport_start(runtime_probe_t *probe);
/**
 * Starts only the diagnostic responder; BEGIN returns the supplied terminal
 * hardware reason.
 *
 * Invariant: reject mode never allocates staging and never activates a
 * session. The probe pointer stays NULL, so handle_begin rejects before any
 * session can become active; DATA/END handlers are inert because they gate on
 * `session.active`. Every future reject-mode path must preserve this.
 */
esp_err_t bundle_transport_start_rejected(const char *reason);
/**
 * Requests cooperative stop and joins the transport task before its probe or
 * staging state is destroyed. On timeout, returns ESP_ERR_TIMEOUT and retains
 * every transport object for a later controlled retry.
 */
esp_err_t bundle_transport_stop(void);
