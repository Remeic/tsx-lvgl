#pragma once

/**
 * Native mirror of the `NativeLvgl` ABI (packages/device/src/native.ts).
 * Every function here is one binding `__native.lvgl` exposes into QuickJS.
 * All calls must run on the LVGL owner task, under `bsp_display_lock`: the
 * host never re-locks internally and never calls back into JS.
 */

#include <stdbool.h>
#include <stdint.h>

#include "lvgl.h"

/** Handles are 1-based (0 is reserved by `loadScreen(0)` for "blank screen"). */
#define LVGL_HOST_MAX_HANDLES 64U

typedef struct lvgl_host lvgl_host_t;

/**
 * Fired synchronously from the LVGL `LV_EVENT_CLICKED` callback (owner task,
 * inside the display lock). Must only queue work — never touch JS or call
 * back into `lvgl_host_*`.
 */
typedef void (*lvgl_host_click_cb_t)(void *user_data, int handle);

lvgl_host_t *lvgl_host_create(lvgl_host_click_cb_t click_cb, void *click_user_data);
void lvgl_host_destroy(lvgl_host_t *host);

/** kind: 0=screen, 1=view, 2=text, 3=button. Mirrors NativeWidgetKind order below. */
typedef enum {
    LVGL_HOST_WIDGET_SCREEN = 0,
    LVGL_HOST_WIDGET_VIEW = 1,
    LVGL_HOST_WIDGET_TEXT = 2,
    LVGL_HOST_WIDGET_BUTTON = 3,
} lvgl_host_widget_kind_t;

/** Returns a handle > 0, or 0 on failure (table full / allocation failure). */
int lvgl_host_create_widget(lvgl_host_t *host, lvgl_host_widget_kind_t kind);
/** Reparents `child` under `parent` and moves it to `index` among its siblings. */
void lvgl_host_insert(lvgl_host_t *host, int parent, int child, int32_t index);
/** `id` must be a Text or Button handle. */
void lvgl_host_set_text(lvgl_host_t *host, int id, const char *text);
void lvgl_host_set_clickable(lvgl_host_t *host, int id, bool clickable);
/**
 * No-op by design: the reconciler (packages/runtime/src/fiber.ts,
 * `unmountFiber`) always calls `dispose` on a removed child immediately
 * after `removeChild`, with no other host op in between, so a deleted
 * child's own `dispose` call is what actually frees it. `remove` only
 * matters for a node staying alive under a different/no parent, which the
 * current reconciler never does (reordering goes through `insert` alone).
 */
void lvgl_host_remove(lvgl_host_t *host, int parent, int child);
/** Deletes `id` (recursive) and frees its table slot. Descendants get their own dispose calls. */
void lvgl_host_dispose(lvgl_host_t *host, int id);
/** `id == 0` loads a fresh blank screen; otherwise loads the screen at `id`. */
void lvgl_host_load_screen(lvgl_host_t *host, int id);

/** Mirrors NATIVE_STYLE_PROP in packages/device/src/style.ts. Append-only; never renumber. */
typedef enum {
    LVGL_HOST_STYLE_BACKGROUND_COLOR = 0,
    LVGL_HOST_STYLE_BORDER_COLOR = 1,
    LVGL_HOST_STYLE_BORDER_WIDTH = 2,
    LVGL_HOST_STYLE_BORDER_RADIUS = 3,
    LVGL_HOST_STYLE_PADDING_TOP = 4,
    LVGL_HOST_STYLE_PADDING_RIGHT = 5,
    LVGL_HOST_STYLE_PADDING_BOTTOM = 6,
    LVGL_HOST_STYLE_PADDING_LEFT = 7,
    LVGL_HOST_STYLE_COLOR = 8,
    LVGL_HOST_STYLE_TEXT_ALIGN = 9,
    LVGL_HOST_STYLE_PROP_COUNT
} lvgl_host_style_prop_t;
void lvgl_host_set_style(lvgl_host_t *host, int id, int prop, int32_t value);
void lvgl_host_reset_style(lvgl_host_t *host, int id, int prop);
