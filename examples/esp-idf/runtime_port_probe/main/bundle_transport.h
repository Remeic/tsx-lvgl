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
/** Stops and joins the transport task before its probe or staging state is destroyed. */
void bundle_transport_stop(void);
