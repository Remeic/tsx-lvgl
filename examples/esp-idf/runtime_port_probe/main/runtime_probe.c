#include "runtime_probe.h"

#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "quickjs.h"

#include "bundle_transport.h"
#include "lvgl_host.h"
#include "waveshare_v1_sensors.h"
#include "waveshare_v1_wifi.h"

#include <inttypes.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *TAG = "tsx_runtime_probe";

#define ENGINE_MEMORY_LIMIT (1024U * 1024U)
#define ENGINE_STACK_LIMIT (32U * 1024U)
#define ENGINE_SMOKE_CYCLES 10U
#define TIMER_SLOT_COUNT 8U
#define WIFI_OPERATION_SLOT_COUNT 4U
#define WIFI_OWNER_OPERATION_TIMEOUT_MS 16000U

typedef enum {
    RUNTIME_PROBE_EVENT_INTERVAL,
    RUNTIME_PROBE_EVENT_TOUCH,
} runtime_probe_event_kind_t;

typedef struct {
    runtime_probe_event_kind_t kind;
    /** Timer slot index for INTERVAL, LVGL widget handle for TOUCH. */
    int arg;
} runtime_probe_event_t;

typedef struct {
    esp_timer_handle_t timer;
    /** JS_UNDEFINED when the slot is free. */
    JSValue callback;
    bool active;
} timer_slot_t;

/** Owned, reference-counted handoff from the transport task to the owner task. */
typedef struct {
    char *manifest_json;
    char *source_text;
    SemaphoreHandle_t done;
    _Atomic uint32_t references;
    runtime_probe_reload_result_t result;
} reload_request_t;

typedef struct {
    int32_t handle;
    uint32_t reload_epoch;
    uint32_t correlation_id;
    TickType_t deadline;
    bool active;
} wifi_operation_slot_t;

struct runtime_probe {
    JSRuntime *runtime;
    JSContext *context;
    lvgl_host_t *lvgl_host;

    /** Dup'd once via __native.onClick(dispatch); JS_UNDEFINED until then. */
    JSValue click_dispatch;
    timer_slot_t timer_slots[TIMER_SLOT_COUNT];

    /** Cached boot-glue globals (kernel.js), resolved once after boot. */
    JSValue pump_fn;
    JSValue reload_fn;
    JSValue lastgen_fn;
    /** __native.board callback, motion observation, and Wi-Fi command slots. */
    JSValue board_sink;
    int32_t board_handle;
    uint32_t board_reload_epoch;
    uint32_t board_last_sequence;
    bool board_active;
    int32_t next_board_handle;
    wifi_operation_slot_t wifi_operations[WIFI_OPERATION_SLOT_COUNT];

    QueueHandle_t event_queue;
    /** Capacity 1: the wire protocol serializes reload attempts (TSXB ERR busy otherwise). */
    QueueHandle_t reload_queue;
    /** Remains true after a caller timeout until the owner releases its request. */
    _Atomic bool reload_in_flight;
    _Atomic uint32_t cached_last_generation;

    waveshare_v1_sensors_t *sensors;
    waveshare_v1_wifi_t *wifi;
    bool sensor_checkpoint_logged;
    bool timer_checkpoint_logged;
    bool lvgl_binding_checkpoint_logged;

    volatile bool active;
};

/** One probe is ever live; recovers the instance for callbacks LVGL/esp_timer invoke with a narrow signature. */
static runtime_probe_t *s_active_probe;

static const char *const TIMER_SLOT_NAMES[TIMER_SLOT_COUNT] = {
    "js_timer_0", "js_timer_1", "js_timer_2", "js_timer_3",
    "js_timer_4", "js_timer_5", "js_timer_6", "js_timer_7",
};

static void release_reload_request(reload_request_t *request);
static runtime_probe_reload_result_t reload_rejected(const char *reason);
static reload_request_t *create_reload_request(const char *manifest_json, const char *source_text);
static JSValue new_wifi_board_event(JSContext *context, int32_t handle, uint32_t reload_epoch,
                                    const waveshare_v1_wifi_event_t *wifi_event);

extern const uint8_t _binary_kernel_js_start[] asm("_binary_kernel_js_start");
extern const uint8_t _binary_kernel_js_end[] asm("_binary_kernel_js_end");
extern const uint8_t _binary_counter_g1_js_start[] asm("_binary_counter_g1_js_start");
extern const uint8_t _binary_counter_g1_manifest_json_start[] asm("_binary_counter_g1_manifest_json_start");

static void log_checkpoint(const char *checkpoint, const char *status, const char *detail)
{
    if (detail == NULL || detail[0] == '\0') {
        ESP_LOGI(TAG, "PROBE checkpoint=%s status=%s", checkpoint, status);
        return;
    }
    ESP_LOGI(TAG, "PROBE checkpoint=%s status=%s %s", checkpoint, status, detail);
}

static size_t free_heap_bytes(void)
{
    return heap_caps_get_free_size(MALLOC_CAP_8BIT);
}

static const char *safe_exception_class(JSContext *context, JSValueConst exception)
{
    JSValue name_value = JS_GetPropertyStr(context, exception, "name");
    if (JS_IsException(name_value)) {
        JS_FreeValue(context, name_value);
        return "unknown";
    }
    const char *name = JS_ToCString(context, name_value);
    const char *result = "other";
    if (name != NULL) {
        if (strcmp(name, "Error") == 0) result = "error";
        else if (strcmp(name, "InternalError") == 0) result = "internal-error";
        else if (strcmp(name, "RangeError") == 0) result = "range-error";
        else if (strcmp(name, "ReferenceError") == 0) result = "reference-error";
        else if (strcmp(name, "SyntaxError") == 0) result = "syntax-error";
        else if (strcmp(name, "TypeError") == 0) result = "type-error";
        else if (strcmp(name, "URIError") == 0) result = "uri-error";
        JS_FreeCString(context, name);
    }
    JS_FreeValue(context, name_value);
    return result;
}

static uint32_t safe_exception_line(JSContext *context, JSValueConst exception)
{
    JSValue stack_value = JS_GetPropertyStr(context, exception, "stack");
    if (JS_IsException(stack_value)) {
        JS_FreeValue(context, stack_value);
        return 0U;
    }
    const char *stack = JS_ToCString(context, stack_value);
    uint32_t line = 0U;
    if (stack != NULL) {
        const char *marker = strstr(stack, "kernel.js:");
        if (marker != NULL) {
            char *end = NULL;
            const unsigned long parsed = strtoul(marker + strlen("kernel.js:"), &end, 10);
            if (end != marker + strlen("kernel.js:") && parsed <= UINT32_MAX) line = (uint32_t)parsed;
        }
        JS_FreeCString(context, stack);
    }
    JS_FreeValue(context, stack_value);
    return line;
}

static void dump_exception(JSContext *context, const char *checkpoint)
{
    JSValue exception = JS_GetException(context);
    /* Exception text is application-controlled; retain only fixed metadata. */
    ESP_LOGE(TAG, "PROBE checkpoint=%s status=fail error=js-exception class=%s line=%u",
             checkpoint, safe_exception_class(context, exception),
             (unsigned)safe_exception_line(context, exception));
    JS_FreeValue(context, exception);
}

static esp_err_t evaluate_smoke_script(JSContext *context)
{
    static const char *const smoke_script =
        "const featureProxy = new Proxy({ ok: true }, {});"
        "const featureMap = new Map([['answer', 42]]);"
        "if (!featureProxy.ok || featureMap.get('answer') !== 42) throw new Error('ES feature failure');"
        "featureMap.get('answer');";

    JSValue result = JS_Eval(context, smoke_script, strlen(smoke_script),
                             "runtime-smoke.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        dump_exception(context, "engine_cycles");
        return ESP_FAIL;
    }
    JS_FreeValue(context, result);
    return ESP_OK;
}

static esp_err_t run_engine_smoke_cycles(void)
{
    const size_t before = free_heap_bytes();
    for (uint32_t cycle = 0; cycle < ENGINE_SMOKE_CYCLES; cycle++) {
        JSRuntime *runtime = JS_NewRuntime();
        if (runtime == NULL) return ESP_ERR_NO_MEM;
        JS_SetRuntimeInfo(runtime, "tsx-lvgl-runtime-probe");
        JS_SetMemoryLimit(runtime, ENGINE_MEMORY_LIMIT);
        JS_SetMaxStackSize(runtime, ENGINE_STACK_LIMIT);

        JSContext *context = JS_NewContext(runtime);
        if (context == NULL) {
            JS_FreeRuntime(runtime);
            return ESP_ERR_NO_MEM;
        }

        const esp_err_t result = evaluate_smoke_script(context);
        JS_RunGC(runtime);
        JS_FreeContext(context);
        JS_FreeRuntime(runtime);
        if (result != ESP_OK) return result;
    }

    const size_t after = free_heap_bytes();
    char detail[128];
    snprintf(detail, sizeof(detail), "cycles=%u free_before=%u free_after=%u psram_free=%u",
             ENGINE_SMOKE_CYCLES, (unsigned)before, (unsigned)after,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    log_checkpoint("engine_cycles", "pass", detail);
    return ESP_OK;
}

static runtime_probe_t *probe_from_context(JSContext *context)
{
    return (runtime_probe_t *)JS_GetContextOpaque(context);
}

static void process_pending_jobs(runtime_probe_t *probe)
{
    JSContext *job_context = NULL;
    int result;
    while ((result = JS_ExecutePendingJob(probe->runtime, &job_context)) > 0) {}
    if (result < 0 && job_context != NULL) dump_exception(job_context, "pending_job");
}

static void queue_probe_event(runtime_probe_t *probe, runtime_probe_event_kind_t kind, int arg)
{
    if (probe == NULL || !probe->active || probe->event_queue == NULL) return;
    const runtime_probe_event_t event = {.kind = kind, .arg = arg};
    if (xQueueSend(probe->event_queue, &event, 0) != pdTRUE) {
        ESP_LOGW(TAG, "PROBE event_queue full kind=%d arg=%d", (int)kind, arg);
    }
}

/* --- __native.lvgl: click delivery (LVGL event context, owner task, under the display lock) --- */

static void probe_click_from_lvgl(void *user_data, int handle)
{
    runtime_probe_t *probe = user_data;
    queue_probe_event(probe, RUNTIME_PROBE_EVENT_TOUCH, handle);
}

/* --- __native.timers: esp_timer fires on the esp_timer task, never the owner task --- */

static void native_timer_fired(void *arg)
{
    runtime_probe_t *probe = s_active_probe;
    if (probe == NULL) return;
    queue_probe_event(probe, RUNTIME_PROBE_EVENT_INTERVAL, (int)(intptr_t)arg);
}

/* --- __native binding surface (packages/device/src/native.ts is the normative contract) --- */

static JSValue js_console_log(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)context;
    (void)this_value;
    (void)argv;
    ESP_LOGI(TAG, "JS log argc=%d", argc);
    return JS_UNDEFINED;
}

static const char *widget_kind_name(lvgl_host_widget_kind_t kind)
{
    switch (kind) {
        case LVGL_HOST_WIDGET_SCREEN: return "screen";
        case LVGL_HOST_WIDGET_VIEW: return "view";
        case LVGL_HOST_WIDGET_TEXT: return "text";
        case LVGL_HOST_WIDGET_BUTTON: return "button";
        default: return "?";
    }
}

static bool parse_widget_kind(const char *text, lvgl_host_widget_kind_t *out)
{
    if (strcmp(text, "screen") == 0) { *out = LVGL_HOST_WIDGET_SCREEN; return true; }
    if (strcmp(text, "view") == 0) { *out = LVGL_HOST_WIDGET_VIEW; return true; }
    if (strcmp(text, "text") == 0) { *out = LVGL_HOST_WIDGET_TEXT; return true; }
    if (strcmp(text, "button") == 0) { *out = LVGL_HOST_WIDGET_BUTTON; return true; }
    return false;
}

static JSValue js_native_lvgl_create(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 1) return JS_ThrowTypeError(context, "lvgl.create(kind) requires kind");

    const char *kind_text = JS_ToCString(context, argv[0]);
    if (kind_text == NULL) return JS_EXCEPTION;
    lvgl_host_widget_kind_t kind;
    const bool valid = parse_widget_kind(kind_text, &kind);
    JS_FreeCString(context, kind_text);
    if (!valid) return JS_ThrowTypeError(context, "lvgl.create: unknown widget kind");

    const int handle = lvgl_host_create_widget(probe->lvgl_host, kind);
    if (handle == 0) return JS_ThrowInternalError(context, "lvgl.create: widget table full");

    if (!probe->lvgl_binding_checkpoint_logged) {
        probe->lvgl_binding_checkpoint_logged = true;
        char detail[48];
        snprintf(detail, sizeof(detail), "kind=%s handle=%d", widget_kind_name(kind), handle);
        log_checkpoint("lvgl_binding", "pass", detail);
    }
    return JS_NewInt32(context, handle);
}

static JSValue js_native_lvgl_insert(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 3) {
        return JS_ThrowTypeError(context, "lvgl.insert(parent, child, index) requires 3 arguments");
    }
    int32_t parent = 0, child = 0, index = 0;
    if (JS_ToInt32(context, &parent, argv[0]) || JS_ToInt32(context, &child, argv[1]) ||
        JS_ToInt32(context, &index, argv[2])) {
        return JS_EXCEPTION;
    }
    lvgl_host_insert(probe->lvgl_host, parent, child, index);
    return JS_UNDEFINED;
}

static JSValue js_native_lvgl_set_text(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 2) return JS_ThrowTypeError(context, "lvgl.setText(id, text) requires 2 arguments");
    int32_t id = 0;
    if (JS_ToInt32(context, &id, argv[0])) return JS_EXCEPTION;
    const char *text = JS_ToCString(context, argv[1]);
    if (text == NULL) return JS_EXCEPTION;
    lvgl_host_set_text(probe->lvgl_host, id, text);
    JS_FreeCString(context, text);
    return JS_UNDEFINED;
}

static JSValue js_native_lvgl_set_clickable(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 2) {
        return JS_ThrowTypeError(context, "lvgl.setClickable(id, clickable) requires 2 arguments");
    }
    int32_t id = 0;
    if (JS_ToInt32(context, &id, argv[0])) return JS_EXCEPTION;
    const int clickable = JS_ToBool(context, argv[1]);
    if (clickable < 0) return JS_EXCEPTION;
    lvgl_host_set_clickable(probe->lvgl_host, id, clickable != 0);
    return JS_UNDEFINED;
}

static JSValue js_native_lvgl_remove(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 2) return JS_ThrowTypeError(context, "lvgl.remove(parent, child) requires 2 arguments");
    int32_t parent = 0, child = 0;
    if (JS_ToInt32(context, &parent, argv[0]) || JS_ToInt32(context, &child, argv[1])) return JS_EXCEPTION;
    lvgl_host_remove(probe->lvgl_host, parent, child);
    return JS_UNDEFINED;
}

static JSValue js_native_lvgl_dispose(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 1) return JS_ThrowTypeError(context, "lvgl.dispose(id) requires id");
    int32_t id = 0;
    if (JS_ToInt32(context, &id, argv[0])) return JS_EXCEPTION;
    lvgl_host_dispose(probe->lvgl_host, id);
    return JS_UNDEFINED;
}

static JSValue js_native_lvgl_load_screen(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 1) return JS_ThrowTypeError(context, "lvgl.loadScreen(id) requires id");
    int32_t id = 0;
    if (JS_ToInt32(context, &id, argv[0])) return JS_EXCEPTION;
    lvgl_host_load_screen(probe->lvgl_host, id);
    return JS_UNDEFINED;
}

static JSValue js_native_timers_set_interval(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 2 || !JS_IsFunction(context, argv[0])) {
        return JS_ThrowTypeError(context, "timers.setInterval(callback, periodMs) requires a function");
    }
    int64_t period_ms = 0;
    if (JS_ToInt64(context, &period_ms, argv[1])) return JS_EXCEPTION;
    if (period_ms < 1) period_ms = 1;

    int slot = -1;
    for (int index = 0; index < (int)TIMER_SLOT_COUNT; index++) {
        if (!probe->timer_slots[index].active) { slot = index; break; }
    }
    if (slot < 0) return JS_ThrowInternalError(context, "timer slot table is full");

    timer_slot_t *entry = &probe->timer_slots[slot];
    entry->callback = JS_DupValue(context, argv[0]);
    const esp_err_t start_result = esp_timer_start_periodic(entry->timer, (uint64_t)period_ms * 1000ULL);
    if (start_result != ESP_OK) {
        JS_FreeValue(context, entry->callback);
        entry->callback = JS_UNDEFINED;
        return JS_ThrowInternalError(context, "native timer start failed");
    }
    entry->active = true;
    return JS_NewInt32(context, slot + 1);
}

static JSValue js_native_timers_clear_interval(JSContext *context, JSValueConst this_value, int argc,
                                               JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 1) return JS_UNDEFINED;
    int32_t handle = 0;
    if (JS_ToInt32(context, &handle, argv[0])) return JS_EXCEPTION;
    const int slot = handle - 1;
    if (slot < 0 || slot >= (int)TIMER_SLOT_COUNT || !probe->timer_slots[slot].active) return JS_UNDEFINED;

    timer_slot_t *entry = &probe->timer_slots[slot];
    (void)esp_timer_stop(entry->timer);
    JS_FreeValue(context, entry->callback);
    entry->callback = JS_UNDEFINED;
    entry->active = false;
    return JS_UNDEFINED;
}

static JSValue new_motion_vector(JSContext *context, double x, double y, double z)
{
    JSValue vector = JS_NewArray(context);
    if (JS_IsException(vector)) return vector;
    if (JS_SetPropertyUint32(context, vector, 0, JS_NewFloat64(context, x)) < 0 ||
        JS_SetPropertyUint32(context, vector, 1, JS_NewFloat64(context, y)) < 0 ||
        JS_SetPropertyUint32(context, vector, 2, JS_NewFloat64(context, z)) < 0) {
        JS_FreeValue(context, vector);
        return JS_EXCEPTION;
    }
    return vector;
}

static JSValue new_board_payload(JSContext *context, const waveshare_v1_motion_frame_t *frame, bool available)
{
    char json[256];
    if (available) {
        snprintf(json, sizeof(json),
                 "{\"status\":\"ok\",\"schemaVersion\":1,\"droppedSincePrevious\":0,\"value\":{\"accelerationMps2\":[%.7g,%.7g,%.7g],\"angularVelocityDps\":[%.7g,%.7g,%.7g]}}",
                 frame->acceleration_mps2[0], frame->acceleration_mps2[1], frame->acceleration_mps2[2],
                 frame->angular_velocity_dps[0], frame->angular_velocity_dps[1], frame->angular_velocity_dps[2]);
    } else {
        snprintf(json, sizeof(json),
                 "{\"status\":\"unavailable\",\"schemaVersion\":1,\"issue\":{\"code\":\"not-ready\",\"retry\":\"automatic\",\"diagnosticId\":\"motion-cache\"}}");
    }
    JSValue payload = JS_NewArray(context);
    if (JS_IsException(payload)) return payload;
    for (uint32_t index = 0; json[index] != '\0'; index++) {
        if (JS_SetPropertyUint32(context, payload, index, JS_NewUint32(context, (uint8_t)json[index])) < 0) {
            JS_FreeValue(context, payload);
            return JS_EXCEPTION;
        }
    }
    return payload;
}

static JSValue new_board_event(JSContext *context, runtime_probe_t *probe, int32_t handle, uint32_t reload_epoch,
                               const waveshare_v1_motion_frame_t *frame, bool available)
{
    JSValue event = JS_NewObject(context);
    if (JS_IsException(event)) return event;
    const uint32_t sequence = available ? frame->sequence : (probe->board_last_sequence + 1U);
    const int64_t observed_at = available ? frame->observed_at_ms : esp_timer_get_time() / 1000;
    JS_SetPropertyStr(context, event, "version", JS_NewInt32(context, 1));
    JS_SetPropertyStr(context, event, "kind", JS_NewString(context, "state"));
    JS_SetPropertyStr(context, event, "handle", JS_NewInt32(context, handle));
    JS_SetPropertyStr(context, event, "reloadEpoch", JS_NewUint32(context, reload_epoch));
    JS_SetPropertyStr(context, event, "sequence", JS_NewUint32(context, sequence));
    JS_SetPropertyStr(context, event, "observedAtMs", JS_NewInt64(context, observed_at));
    JS_SetPropertyStr(context, event, "payload", new_board_payload(context, frame, available));
    return event;
}

static JSValue js_native_board_list(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    (void)argc;
    (void)argv;
    JSValue entries = JS_NewArray(context);
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL) return entries;
    if (probe->sensors == NULL) return entries;
    JSValue descriptor = JS_NewObject(context);
    JS_SetPropertyStr(context, descriptor, "familyCode", JS_NewInt32(context, 0x0101));
    JS_SetPropertyStr(context, descriptor, "semanticId", JS_NewString(context, "device.motion"));
    JS_SetPropertyStr(context, descriptor, "instanceId", JS_NewString(context, "motion"));
    JS_SetPropertyStr(context, descriptor, "version", JS_NewInt32(context, 1));
    JS_SetPropertyStr(context, descriptor, "source", JS_NewString(context, "qmi8658"));
    JS_SetPropertyStr(context, descriptor, "isDefault", JS_NewBool(context, true));
    JS_SetPropertyStr(context, descriptor, "delivery", JS_NewString(context, "snapshot"));
    JS_SetPropertyStr(context, descriptor, "defaultPeriodMs", JS_NewInt32(context, 80));
    JS_SetPropertyStr(context, descriptor, "minPeriodMs", JS_NewInt32(context, 20));
    JS_SetPropertyStr(context, descriptor, "maxPeriodMs", JS_NewInt32(context, 1000));
    JS_SetPropertyStr(context, descriptor, "maxFrameBytes", JS_NewInt32(context, 512));
    JS_SetPropertyUint32(context, entries, 0, descriptor);
    return entries;
}

static JSValue js_native_board_read_cached(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 1) return JS_UNDEFINED;
    const char *instance_id = JS_ToCString(context, argv[0]);
    const bool is_motion = instance_id != NULL && strcmp(instance_id, "motion") == 0;
    const bool is_wifi = instance_id != NULL && strcmp(instance_id, "wifi.station") == 0;
    JS_FreeCString(context, instance_id);
    if (is_wifi && probe->wifi != NULL) {
        const waveshare_v1_wifi_event_t state = waveshare_v1_wifi_state(probe->wifi);
        return new_wifi_board_event(context, 0, 1U, &state);
    }
    if (!is_motion) return JS_UNDEFINED;
    if (probe->sensors == NULL) return JS_UNDEFINED;
    const int32_t handle = probe->board_handle == 0 ? 1 : probe->board_handle;
    const uint32_t epoch = probe->board_reload_epoch == 0 ? 1U : probe->board_reload_epoch;
    waveshare_v1_motion_frame_t frame = {0};
    const bool available = waveshare_v1_sensors_read_motion(probe->sensors, &frame);
    return new_board_event(context, probe, handle, epoch, &frame, available);
}

static JSValue js_native_board_submit(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 1) return JS_ThrowTypeError(context, "board.submit(request) requires request");
    JSValue kind = JS_GetPropertyStr(context, argv[0], "kind");
    const char *kind_name = JS_ToCString(context, kind);
    const bool is_observe = kind_name != NULL && strcmp(kind_name, "observe") == 0;
    const bool is_command = kind_name != NULL && strcmp(kind_name, "command") == 0;
    JS_FreeCString(context, kind_name);
    JS_FreeValue(context, kind);
    if (is_command) {
        if (probe->wifi == NULL) return JS_ThrowInternalError(context, "board.submit: Wi-Fi command unavailable");
        JSValue instance = JS_GetPropertyStr(context, argv[0], "instanceId");
        JSValue command = JS_GetPropertyStr(context, argv[0], "commandId");
        JSValue correlation = JS_GetPropertyStr(context, argv[0], "correlationId");
        JSValue epoch = JS_GetPropertyStr(context, argv[0], "reloadEpoch");
        const char *instance_id = JS_ToCString(context, instance);
        const char *command_id = JS_ToCString(context, command);
        const char *correlation_id = JS_ToCString(context, correlation);
        int32_t reload_epoch = 0;
        char *end = NULL;
        const unsigned long parsed_correlation = correlation_id == NULL ? 0UL : strtoul(correlation_id, &end, 10);
        waveshare_v1_wifi_command_t native_command = WAVESHARE_V1_WIFI_SCAN;
        const bool valid_command = command_id != NULL && (strcmp(command_id, "scan") == 0 || strcmp(command_id, "connect") == 0 || strcmp(command_id, "disconnect") == 0);
        if (command_id != NULL && strcmp(command_id, "connect") == 0) native_command = WAVESHARE_V1_WIFI_CONNECT;
        if (command_id != NULL && strcmp(command_id, "disconnect") == 0) native_command = WAVESHARE_V1_WIFI_DISCONNECT;
        const bool valid = instance_id != NULL && strcmp(instance_id, "wifi.station") == 0 && valid_command &&
                           correlation_id != NULL && end != correlation_id && *end == '\0' && parsed_correlation > 0UL && parsed_correlation <= UINT32_MAX &&
                           JS_ToInt32(context, &reload_epoch, epoch) == 0 && reload_epoch > 0;
        JS_FreeCString(context, instance_id);
        JS_FreeCString(context, command_id);
        JS_FreeCString(context, correlation_id);
        JS_FreeValue(context, instance);
        JS_FreeValue(context, command);
        JS_FreeValue(context, correlation);
        JS_FreeValue(context, epoch);
        if (!valid) return JS_ThrowTypeError(context, "board.submit: invalid Wi-Fi command");
        wifi_operation_slot_t *slot = NULL;
        for (uint32_t index = 0; index < WIFI_OPERATION_SLOT_COUNT; index++) if (!probe->wifi_operations[index].active) { slot = &probe->wifi_operations[index]; break; }
        if (slot == NULL) return JS_ThrowInternalError(context, "board.submit: wifi-command-queue-full");
        const esp_err_t submit_result = waveshare_v1_wifi_submit(probe->wifi, native_command, (uint32_t)parsed_correlation);
        if (submit_result != ESP_OK) {
            return JS_ThrowInternalError(context, submit_result == ESP_ERR_TIMEOUT
                                         ? "board.submit: wifi-command-queue-full"
                                         : "board.submit: Wi-Fi command unavailable");
        }
        slot->handle = ++probe->next_board_handle;
        slot->reload_epoch = (uint32_t)reload_epoch;
        slot->correlation_id = (uint32_t)parsed_correlation;
        slot->deadline = xTaskGetTickCount() + pdMS_TO_TICKS(WIFI_OWNER_OPERATION_TIMEOUT_MS);
        slot->active = true;
        return JS_NewInt32(context, slot->handle);
    }
    if (!is_observe) return JS_ThrowTypeError(context, "board.submit: unsupported request");
    JSValue instance = JS_GetPropertyStr(context, argv[0], "instanceId");
    JSValue epoch = JS_GetPropertyStr(context, argv[0], "reloadEpoch");
    JSValue period = JS_GetPropertyStr(context, argv[0], "periodMs");
    const char *instance_id = JS_ToCString(context, instance);
    int32_t reload_epoch = 0;
    int32_t period_ms = 0;
    const bool valid = instance_id != NULL && strcmp(instance_id, "motion") == 0 && JS_ToInt32(context, &reload_epoch, epoch) == 0 && reload_epoch > 0 &&
                       JS_ToInt32(context, &period_ms, period) == 0 && period_ms >= (int32_t)WAVESHARE_V1_MOTION_MIN_PERIOD_MS &&
                       period_ms <= (int32_t)WAVESHARE_V1_MOTION_MAX_PERIOD_MS;
    JS_FreeCString(context, instance_id);
    JS_FreeValue(context, instance);
    JS_FreeValue(context, epoch);
    JS_FreeValue(context, period);
    if (!valid) return JS_ThrowTypeError(context, "board.submit: invalid motion observation");
    if (probe->sensors == NULL) return JS_ThrowInternalError(context, "board.submit: motion cadence unavailable");
    if (waveshare_v1_sensors_set_period_ms(probe->sensors, (uint32_t)period_ms) != ESP_OK) {
        return JS_ThrowInternalError(context, "board.submit: motion cadence unavailable");
    }
    probe->board_handle = ++probe->next_board_handle;
    probe->board_reload_epoch = (uint32_t)reload_epoch;
    probe->board_last_sequence = 0;
    probe->board_active = true;
    return JS_NewInt32(context, probe->board_handle);
}

static JSValue js_native_board_cancel(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    int32_t handle = 0;
    if (probe == NULL || argc < 1 || JS_ToInt32(context, &handle, argv[0]) != 0) return JS_UNDEFINED;
    if (handle == probe->board_handle) probe->board_active = false;
    for (uint32_t index = 0; index < WIFI_OPERATION_SLOT_COUNT; index++) {
        wifi_operation_slot_t *slot = &probe->wifi_operations[index];
        if (slot->active && slot->handle == handle) {
            if (probe->wifi != NULL) waveshare_v1_wifi_cancel(probe->wifi, slot->correlation_id);
            slot->active = false;
        }
    }
    return JS_UNDEFINED;
}

static JSValue js_native_board_set_sink(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 1 || !JS_IsFunction(context, argv[0])) return JS_ThrowTypeError(context, "board.setSink(listener) requires function");
    if (!JS_IsUndefined(probe->board_sink)) JS_FreeValue(context, probe->board_sink);
    probe->board_sink = JS_DupValue(context, argv[0]);
    return JS_UNDEFINED;
}

static JSValue js_native_board_dispose(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    (void)argc;
    (void)argv;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe != NULL) {
        probe->board_active = false;
        for (uint32_t index = 0; index < WIFI_OPERATION_SLOT_COUNT; index++) {
            if (probe->wifi != NULL && probe->wifi_operations[index].active) {
                waveshare_v1_wifi_cancel(probe->wifi, probe->wifi_operations[index].correlation_id);
            }
            probe->wifi_operations[index].active = false;
        }
    }
    return JS_UNDEFINED;
}

static void emit_board_reading(runtime_probe_t *probe)
{
    if (probe->sensors == NULL || !probe->board_active || JS_IsUndefined(probe->board_sink)) return;
    waveshare_v1_motion_frame_t frame = {0};
    if (!waveshare_v1_sensors_read_motion(probe->sensors, &frame) || frame.sequence <= probe->board_last_sequence) return;
    JSValue event = new_board_event(probe->context, probe, probe->board_handle, probe->board_reload_epoch, &frame, true);
    JSValue result = JS_Call(probe->context, probe->board_sink, JS_UNDEFINED, 1, &event);
    JS_FreeValue(probe->context, event);
    if (JS_IsException(result)) {
        JS_FreeValue(probe->context, result);
        dump_exception(probe->context, "board_event");
        return;
    }
    JS_FreeValue(probe->context, result);
    probe->board_last_sequence = frame.sequence;
}

static JSValue new_ascii_payload(JSContext *context, const char *json)
{
    JSValue payload = JS_NewArray(context);
    if (JS_IsException(payload)) return payload;
    for (uint32_t index = 0; json[index] != '\0'; index++) {
        if (JS_SetPropertyUint32(context, payload, index, JS_NewUint32(context, (uint8_t)json[index])) < 0) {
            JS_FreeValue(context, payload);
            return JS_EXCEPTION;
        }
    }
    return payload;
}

static wifi_operation_slot_t *find_wifi_operation(runtime_probe_t *probe, uint32_t correlation_id)
{
    for (uint32_t index = 0; index < WIFI_OPERATION_SLOT_COUNT; index++) {
        wifi_operation_slot_t *slot = &probe->wifi_operations[index];
        if (slot->active && slot->correlation_id == correlation_id) return slot;
    }
    return NULL;
}

static const char *wifi_phase_name(waveshare_v1_wifi_phase_t phase)
{
    switch (phase) {
        case WAVESHARE_V1_WIFI_IDLE: return "idle";
        case WAVESHARE_V1_WIFI_CONNECTING: return "connecting";
        case WAVESHARE_V1_WIFI_CONNECTED: return "connected";
        case WAVESHARE_V1_WIFI_DISABLED: return "disabled";
    }
    return "disabled";
}

static JSValue new_wifi_board_event(JSContext *context, int32_t handle, uint32_t reload_epoch,
                                    const waveshare_v1_wifi_event_t *wifi_event)
{
    char json[256];
    if (wifi_event->kind == WAVESHARE_V1_WIFI_EVENT_STATE) {
        if (wifi_event->phase == WAVESHARE_V1_WIFI_CONNECTED) {
            snprintf(json, sizeof(json),
                     "{\"status\":\"ok\",\"value\":{\"phase\":\"connected\",\"station\":{\"rssiDbm\":%d,\"channel\":%u,\"authKind\":\"unknown\"}}}",
                     (int)wifi_event->rssi_dbm, (unsigned)wifi_event->channel);
        } else {
            snprintf(json, sizeof(json), "{\"status\":\"ok\",\"value\":{\"phase\":\"%s\"}}", wifi_phase_name(wifi_event->phase));
        }
    } else if (wifi_event->kind == WAVESHARE_V1_WIFI_EVENT_SUCCEEDED) {
        snprintf(json, sizeof(json), "{\"status\":\"succeeded\",\"correlationId\":\"%u\"}", (unsigned)wifi_event->correlation_id);
    } else {
        const char *diagnostic_id = wifi_event->diagnostic_id == NULL ? "wifi-provider" : wifi_event->diagnostic_id;
        const char *code = strcmp(diagnostic_id, "wifi-disabled") == 0 ? "unsupported" :
                           strcmp(diagnostic_id, "wifi-command-timeout") == 0 || strcmp(diagnostic_id, "wifi-owner-timeout") == 0 ? "timeout" :
                           strcmp(diagnostic_id, "wifi-event-queue-full") == 0 ? "resource-exhausted" : "hardware-failure";
        snprintf(json, sizeof(json),
                 "{\"status\":\"failed\",\"correlationId\":\"%u\",\"issue\":{\"code\":\"%s\",\"retry\":\"never\",\"diagnosticId\":\"%s\"}}",
                 (unsigned)wifi_event->correlation_id, code, diagnostic_id);
    }
    JSValue event = JS_NewObject(context);
    JS_SetPropertyStr(context, event, "version", JS_NewInt32(context, 1));
    JS_SetPropertyStr(context, event, "kind", JS_NewString(context, wifi_event->kind == WAVESHARE_V1_WIFI_EVENT_STATE ? "state" : "operation"));
    JS_SetPropertyStr(context, event, "instanceId", JS_NewString(context, "wifi.station"));
    JS_SetPropertyStr(context, event, "handle", JS_NewInt32(context, handle));
    JS_SetPropertyStr(context, event, "reloadEpoch", JS_NewUint32(context, reload_epoch));
    JS_SetPropertyStr(context, event, "sequence", JS_NewUint32(context, wifi_event->sequence));
    JS_SetPropertyStr(context, event, "observedAtMs", JS_NewInt64(context, esp_timer_get_time() / 1000));
    JS_SetPropertyStr(context, event, "payload", new_ascii_payload(context, json));
    return event;
}

static void emit_wifi_events(runtime_probe_t *probe)
{
    if (probe->wifi == NULL || JS_IsUndefined(probe->board_sink)) return;
    waveshare_v1_wifi_event_t wifi_event;
    while (waveshare_v1_wifi_take_event(probe->wifi, &wifi_event)) {
        wifi_operation_slot_t *slot = find_wifi_operation(probe, wifi_event.correlation_id);
        if (wifi_event.kind != WAVESHARE_V1_WIFI_EVENT_STATE && slot == NULL) continue;
        const int32_t handle = slot == NULL ? 0 : slot->handle;
        const uint32_t epoch = slot == NULL ? 1U : slot->reload_epoch;
        JSValue event = new_wifi_board_event(probe->context, handle, epoch, &wifi_event);
        JSValue result = JS_Call(probe->context, probe->board_sink, JS_UNDEFINED, 1, &event);
        JS_FreeValue(probe->context, event);
        if (JS_IsException(result)) dump_exception(probe->context, "wifi_board_event");
        JS_FreeValue(probe->context, result);
        if (slot != NULL && wifi_event.kind != WAVESHARE_V1_WIFI_EVENT_STATE) slot->active = false;
    }
}

/* The provider may lose an event only by exhausting its bounded queue. The
 * owner clock still terminalizes the correlated JS operation without logging
 * identity or credentials. */
static void expire_wifi_operations(runtime_probe_t *probe)
{
    if (probe->wifi == NULL || JS_IsUndefined(probe->board_sink)) return;
    const TickType_t now = xTaskGetTickCount();
    for (uint32_t index = 0; index < WIFI_OPERATION_SLOT_COUNT; index++) {
        wifi_operation_slot_t *slot = &probe->wifi_operations[index];
        if (!slot->active || (int32_t)(now - slot->deadline) < 0) continue;
        const waveshare_v1_wifi_event_t state = waveshare_v1_wifi_state(probe->wifi);
        const waveshare_v1_wifi_event_t timeout = {
            .kind = WAVESHARE_V1_WIFI_EVENT_FAILED,
            .phase = state.phase,
            .command = WAVESHARE_V1_WIFI_SCAN,
            .correlation_id = slot->correlation_id,
            .sequence = state.sequence + 1U,
            .rssi_dbm = -127,
            .channel = 1,
            .auth_kind = 5,
            .diagnostic_id = "wifi-owner-timeout",
        };
        waveshare_v1_wifi_cancel(probe->wifi, slot->correlation_id);
        JSValue event = new_wifi_board_event(probe->context, slot->handle, slot->reload_epoch, &timeout);
        JSValue result = JS_Call(probe->context, probe->board_sink, JS_UNDEFINED, 1, &event);
        JS_FreeValue(probe->context, event);
        if (JS_IsException(result)) dump_exception(probe->context, "wifi_owner_timeout");
        JS_FreeValue(probe->context, result);
        slot->active = false;
    }
}

/**
 * Backs `__native.sensors.read`. Returns the `NativeMotionReading` shape
 * `packages/device/src/sensors.ts` expects: `{status, sampledAtMs, value?}`
 * with no sensorId/schemaVersion/sequence/reloadEpoch — the JS side (not
 * this binding) owns those fencing fields.
 */
static JSValue js_native_sensor_read(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 1) return JS_ThrowTypeError(context, "sensors.read(sensorId) requires sensorId");

    const char *sensor_id = JS_ToCString(context, argv[0]);
    if (sensor_id == NULL) return JS_EXCEPTION;
    const bool is_motion = strcmp(sensor_id, "device.motion") == 0;
    JS_FreeCString(context, sensor_id);
    if (!is_motion) return JS_ThrowTypeError(context, "sensors.read: unknown sensorId");

    const bool is_first_call = !probe->sensor_checkpoint_logged;
    probe->sensor_checkpoint_logged = true;

    JSValue sample = JS_NewObject(context);
    if (JS_IsException(sample)) return sample;
    waveshare_v1_motion_frame_t frame = {0};
    if (probe->sensors == NULL || !waveshare_v1_sensors_read_motion(probe->sensors, &frame)) {
        JS_SetPropertyStr(context, sample, "status", JS_NewString(context, "unavailable"));
        JS_SetPropertyStr(context, sample, "sampledAtMs", JS_NewInt64(context, esp_timer_get_time() / 1000));
        if (is_first_call) log_checkpoint("sensor_read", "fail", "sensor=device.motion cache-unavailable");
        return sample;
    }
    JSValue value = JS_NewObject(context);
    if (JS_IsException(value)) return value;
    JS_SetPropertyStr(context, value, "accelerationMps2",
                      new_motion_vector(context, frame.acceleration_mps2[0], frame.acceleration_mps2[1], frame.acceleration_mps2[2]));
    JS_SetPropertyStr(context, value, "angularVelocityDps",
                      new_motion_vector(context, frame.angular_velocity_dps[0], frame.angular_velocity_dps[1], frame.angular_velocity_dps[2]));
    JS_SetPropertyStr(context, sample, "status", JS_NewString(context, "ok"));
    JS_SetPropertyStr(context, sample, "sampledAtMs", JS_NewInt64(context, frame.observed_at_ms));
    JS_SetPropertyStr(context, sample, "value", value);
    if (is_first_call) log_checkpoint("sensor_read", "pass", "sensor=device.motion cache=true");
    return sample;
}

static JSValue js_native_on_click(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    runtime_probe_t *probe = probe_from_context(context);
    if (probe == NULL || argc < 1 || !JS_IsFunction(context, argv[0])) {
        return JS_ThrowTypeError(context, "onClick(dispatch) requires a function");
    }
    if (!JS_IsUndefined(probe->click_dispatch)) JS_FreeValue(context, probe->click_dispatch);
    probe->click_dispatch = JS_DupValue(context, argv[0]);
    return JS_UNDEFINED;
}

static JSValue js_native_log(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    return js_console_log(context, this_value, argc, argv);
}

static esp_err_t install_native_bindings(runtime_probe_t *probe)
{
    JSContext *context = probe->context;
    JSValue global = JS_GetGlobalObject(context);

    JSValue console = JS_NewObject(context);
    JS_SetPropertyStr(context, console, "log", JS_NewCFunction(context, js_console_log, "log", 8));
    JS_SetPropertyStr(context, global, "console", console);

    JSValue native = JS_NewObject(context);
    JS_SetPropertyStr(context, native, "boardId", JS_NewString(context, RUNTIME_PROBE_BOARD_ID));

    JSValue lvgl = JS_NewObject(context);
    JS_SetPropertyStr(context, lvgl, "create", JS_NewCFunction(context, js_native_lvgl_create, "create", 1));
    JS_SetPropertyStr(context, lvgl, "insert", JS_NewCFunction(context, js_native_lvgl_insert, "insert", 3));
    JS_SetPropertyStr(context, lvgl, "setText", JS_NewCFunction(context, js_native_lvgl_set_text, "setText", 2));
    JS_SetPropertyStr(context, lvgl, "setClickable",
                      JS_NewCFunction(context, js_native_lvgl_set_clickable, "setClickable", 2));
    JS_SetPropertyStr(context, lvgl, "remove", JS_NewCFunction(context, js_native_lvgl_remove, "remove", 2));
    JS_SetPropertyStr(context, lvgl, "dispose", JS_NewCFunction(context, js_native_lvgl_dispose, "dispose", 1));
    JS_SetPropertyStr(context, lvgl, "loadScreen",
                      JS_NewCFunction(context, js_native_lvgl_load_screen, "loadScreen", 1));
    JS_SetPropertyStr(context, native, "lvgl", lvgl);

    JSValue timers = JS_NewObject(context);
    JS_SetPropertyStr(context, timers, "setInterval",
                      JS_NewCFunction(context, js_native_timers_set_interval, "setInterval", 2));
    JS_SetPropertyStr(context, timers, "clearInterval",
                      JS_NewCFunction(context, js_native_timers_clear_interval, "clearInterval", 1));
    JS_SetPropertyStr(context, native, "timers", timers);

    JSValue sensors = JS_NewObject(context);
    JS_SetPropertyStr(context, sensors, "read", JS_NewCFunction(context, js_native_sensor_read, "read", 1));
    JS_SetPropertyStr(context, native, "sensors", sensors);

    JSValue board = JS_NewObject(context);
    JS_SetPropertyStr(context, board, "list", JS_NewCFunction(context, js_native_board_list, "list", 0));
    JS_SetPropertyStr(context, board, "readCached", JS_NewCFunction(context, js_native_board_read_cached, "readCached", 1));
    JS_SetPropertyStr(context, board, "submit", JS_NewCFunction(context, js_native_board_submit, "submit", 1));
    JS_SetPropertyStr(context, board, "cancel", JS_NewCFunction(context, js_native_board_cancel, "cancel", 1));
    JS_SetPropertyStr(context, board, "setSink", JS_NewCFunction(context, js_native_board_set_sink, "setSink", 1));
    JS_SetPropertyStr(context, board, "dispose", JS_NewCFunction(context, js_native_board_dispose, "dispose", 0));
    JS_SetPropertyStr(context, native, "board", board);

    JS_SetPropertyStr(context, native, "onClick", JS_NewCFunction(context, js_native_on_click, "onClick", 1));
    JS_SetPropertyStr(context, native, "log", JS_NewCFunction(context, js_native_log, "log", 1));

    JS_SetPropertyStr(context, global, "__native", native);
    JS_FreeValue(context, global);
    return ESP_OK;
}

/* --- Boot: evaluate kernel.js, then mount the baked-in Counter bundle (generation 1) --- */

esp_err_t runtime_probe_boot(runtime_probe_t *probe)
{
    if (probe == NULL) return ESP_ERR_INVALID_STATE;
    JSContext *context = probe->context;
    size_t kernel_length = (size_t)(_binary_kernel_js_end - _binary_kernel_js_start);
    /* ESP-IDF EMBED_TXTFILES appends a C-string terminator; QuickJS parses the
     * explicit byte range and rejects that NUL as an unexpected token. */
    if (kernel_length > 0U && _binary_kernel_js_start[kernel_length - 1U] == '\0') kernel_length--;
    JSValue eval_result = JS_Eval(context, (const char *)_binary_kernel_js_start, kernel_length, "kernel.js",
                                  JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(eval_result)) {
        dump_exception(context, "js_eval");
        return ESP_FAIL;
    }
    JS_FreeValue(context, eval_result);
    process_pending_jobs(probe);

    char eval_detail[64];
    snprintf(eval_detail, sizeof(eval_detail), "script=kernel.js bytes=%u", (unsigned)kernel_length);
    log_checkpoint("js_eval", "pass", eval_detail);

    JSValue global = JS_GetGlobalObject(context);
    JSValue boot_fn = JS_GetPropertyStr(context, global, "__tsxKernelBoot");
    probe->pump_fn = JS_GetPropertyStr(context, global, "__tsxKernelPump");
    probe->reload_fn = JS_GetPropertyStr(context, global, "__tsxKernelReload");
    probe->lastgen_fn = JS_GetPropertyStr(context, global, "__tsxKernelLastGeneration");
    JS_FreeValue(context, global);

    const bool boot_glue_present = JS_IsFunction(context, boot_fn) && JS_IsFunction(context, probe->pump_fn) &&
                                   JS_IsFunction(context, probe->reload_fn) && JS_IsFunction(context, probe->lastgen_fn);
    if (!boot_glue_present) {
        JS_FreeValue(context, boot_fn);
        log_checkpoint("kernel_start", "fail", "boot glue missing");
        return ESP_FAIL;
    }
    log_checkpoint("kernel_start", "pass", "boot_glue=present");

    JSValue manifest_value = JS_NewString(context, (const char *)_binary_counter_g1_manifest_json_start);
    JSValue source_value = JS_NewString(context, (const char *)_binary_counter_g1_js_start);
    JSValue argv[2] = {manifest_value, source_value};
    JSValue boot_result = JS_Call(context, boot_fn, JS_UNDEFINED, 2, argv);
    JS_FreeValue(context, manifest_value);
    JS_FreeValue(context, source_value);
    JS_FreeValue(context, boot_fn);

    if (JS_IsException(boot_result)) {
        dump_exception(context, "app_mount");
        JS_FreeValue(context, boot_result);
        return ESP_FAIL;
    }
    JS_FreeValue(context, boot_result);
    process_pending_jobs(probe);
    log_checkpoint("app_mount", "pass", "bundle=counter generation=1");

    JSValue lastgen_result = JS_Call(context, probe->lastgen_fn, JS_UNDEFINED, 0, NULL);
    int32_t last_generation = 1;
    if (!JS_IsException(lastgen_result)) (void)JS_ToInt32(context, &last_generation, lastgen_result);
    JS_FreeValue(context, lastgen_result);
    atomic_store(&probe->cached_last_generation, (uint32_t)(last_generation > 0 ? last_generation : 1));

    return ESP_OK;
}

/* --- Owner loop: events, kernel pump, pending jobs, then the reload quiescent point --- */

static void process_probe_event(runtime_probe_t *probe, const runtime_probe_event_t *event)
{
    if (event->kind == RUNTIME_PROBE_EVENT_TOUCH) {
        if (JS_IsUndefined(probe->click_dispatch)) return;
        JSValue handle_value = JS_NewInt32(probe->context, event->arg);
        JSValue result = JS_Call(probe->context, probe->click_dispatch, JS_UNDEFINED, 1, &handle_value);
        JS_FreeValue(probe->context, handle_value);
        if (JS_IsException(result)) {
            JS_FreeValue(probe->context, result);
            dump_exception(probe->context, "touch_callback");
            return;
        }
        JS_FreeValue(probe->context, result);
        log_checkpoint("touch_callback", "pass", "event=clicked");
        process_pending_jobs(probe);
        return;
    }

    const int slot = event->arg;
    if (slot < 0 || slot >= (int)TIMER_SLOT_COUNT || !probe->timer_slots[slot].active) return;
    JSValue callback = probe->timer_slots[slot].callback;
    if (JS_IsUndefined(callback)) return;
    JSValue result = JS_Call(probe->context, callback, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(result)) {
        JS_FreeValue(probe->context, result);
        dump_exception(probe->context, "timer_callback");
        return;
    }
    JS_FreeValue(probe->context, result);
    if (!probe->timer_checkpoint_logged) {
        probe->timer_checkpoint_logged = true;
        log_checkpoint("timer_callback", "pass", "");
    }
    process_pending_jobs(probe);
}

static void process_pending_events(runtime_probe_t *probe)
{
    runtime_probe_event_t event;
    while (probe->event_queue != NULL && xQueueReceive(probe->event_queue, &event, 0) == pdTRUE) {
        process_probe_event(probe, &event);
    }
}

static void call_kernel_pump(runtime_probe_t *probe)
{
    JSValue result = JS_Call(probe->context, probe->pump_fn, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(result)) dump_exception(probe->context, "kernel_pump");
    JS_FreeValue(probe->context, result);
}

/** Parses `stageReload`'s return string (packages/device/src/kernel.ts): "committed <epoch>" | "rejected <reason>" | "rolled_back". */
static void parse_reload_status(const char *status, runtime_probe_reload_result_t *out)
{
    memset(out, 0, sizeof(*out));
    unsigned epoch = 0;
    if (sscanf(status, "committed %u", &epoch) == 1) {
        out->kind = RUNTIME_PROBE_RELOAD_COMMITTED;
        out->epoch = epoch;
        return;
    }
    if (strcmp(status, "rolled_back") == 0) {
        out->kind = RUNTIME_PROBE_RELOAD_ROLLED_BACK;
        return;
    }
    const char *reason = strncmp(status, "rejected ", 9) == 0 ? status + 9 : "unknown";
    out->kind = RUNTIME_PROBE_RELOAD_REJECTED;
    snprintf(out->reason, sizeof(out->reason), "%s", reason);
}

static void process_reload_handoff(runtime_probe_t *probe)
{
    reload_request_t *request = NULL;
    if (xQueueReceive(probe->reload_queue, &request, 0) != pdTRUE) return;

    JSContext *context = probe->context;
    JSValue manifest_value = JS_NewString(context, request->manifest_json);
    JSValue source_value = JS_NewString(context, request->source_text);
    JSValue argv[2] = {manifest_value, source_value};
    JSValue call_result = JS_Call(context, probe->reload_fn, JS_UNDEFINED, 2, argv);
    JS_FreeValue(context, manifest_value);
    JS_FreeValue(context, source_value);

    runtime_probe_reload_result_t outcome;
    memset(&outcome, 0, sizeof(outcome));
    if (JS_IsException(call_result)) {
        dump_exception(context, "bundle_reload");
        outcome.kind = RUNTIME_PROBE_RELOAD_REJECTED;
        snprintf(outcome.reason, sizeof(outcome.reason), "js-exception");
        log_checkpoint("bundle_reject", "pass", "reason=js-exception");
    } else {
        const char *status = JS_ToCString(context, call_result);
        if (status != NULL) {
            parse_reload_status(status, &outcome);
            JS_FreeCString(context, status);
        } else {
            outcome.kind = RUNTIME_PROBE_RELOAD_REJECTED;
            snprintf(outcome.reason, sizeof(outcome.reason), "unprintable-status");
        }

        if (outcome.kind == RUNTIME_PROBE_RELOAD_COMMITTED) {
            char detail[32];
            snprintf(detail, sizeof(detail), "epoch=%u", (unsigned)outcome.epoch);
            log_checkpoint("bundle_reload", "pass", detail);
        } else {
            char detail[96];
            const char *reason = outcome.kind == RUNTIME_PROBE_RELOAD_ROLLED_BACK ? "evaluate-rolled-back"
                                                                                  : outcome.reason;
            snprintf(detail, sizeof(detail), "reason=%s", reason);
            log_checkpoint("bundle_reject", "pass", detail);
        }
    }
    JS_FreeValue(context, call_result);

    JSValue lastgen_result = JS_Call(context, probe->lastgen_fn, JS_UNDEFINED, 0, NULL);
    if (!JS_IsException(lastgen_result)) {
        int32_t last_generation = 0;
        if (!JS_ToInt32(context, &last_generation, lastgen_result) && last_generation >= 0) {
            atomic_store(&probe->cached_last_generation, (uint32_t)last_generation);
        }
    }
    JS_FreeValue(context, lastgen_result);

    process_pending_jobs(probe);

    request->result = outcome;
    atomic_store(&probe->reload_in_flight, false);
    xSemaphoreGive(request->done);
    release_reload_request(request);
}

static void release_reload_request(reload_request_t *request)
{
    if (request == NULL) return;
    if (atomic_fetch_sub(&request->references, 1U) != 1U) return;
    vSemaphoreDelete(request->done);
    free(request->manifest_json);
    heap_caps_free(request->source_text);
    free(request);
}

static runtime_probe_reload_result_t reload_rejected(const char *reason)
{
    runtime_probe_reload_result_t result;
    memset(&result, 0, sizeof(result));
    result.kind = RUNTIME_PROBE_RELOAD_REJECTED;
    snprintf(result.reason, sizeof(result.reason), "%s", reason);
    return result;
}

static reload_request_t *create_reload_request(const char *manifest_json, const char *source_text)
{
    if (manifest_json == NULL || source_text == NULL) return NULL;

    const size_t manifest_length = strnlen(manifest_json, 2048U);
    const size_t source_length = strnlen(source_text, (size_t)RUNTIME_BUNDLE_MAX_BYTES + 1U);
    if (manifest_length >= 2048U || source_length > RUNTIME_BUNDLE_MAX_BYTES) return NULL;

    reload_request_t *request = calloc(1, sizeof(*request));
    if (request == NULL) return NULL;
    request->manifest_json = malloc(manifest_length + 1U);
    request->source_text = heap_caps_malloc(source_length + 1U, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    request->done = xSemaphoreCreateBinary();
    if (request->manifest_json == NULL || request->source_text == NULL || request->done == NULL) {
        if (request->done != NULL) vSemaphoreDelete(request->done);
        free(request->manifest_json);
        heap_caps_free(request->source_text);
        free(request);
        return NULL;
    }

    memcpy(request->manifest_json, manifest_json, manifest_length + 1U);
    memcpy(request->source_text, source_text, source_length + 1U);
    atomic_init(&request->references, 2U); /* caller + owner */
    return request;
}

void runtime_probe_task(void *arg)
{
    runtime_probe_t *probe = arg;
    while (probe != NULL && probe->active) {
        if (bsp_display_lock(100)) {
            JS_UpdateStackTop(probe->runtime);
            process_pending_events(probe);
            emit_board_reading(probe);
            expire_wifi_operations(probe);
            emit_wifi_events(probe);
            call_kernel_pump(probe);
            process_pending_jobs(probe);
            process_reload_handoff(probe);
            bsp_display_unlock();
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    vTaskDelete(NULL);
}

runtime_probe_reload_result_t runtime_probe_stage_reload(runtime_probe_t *probe, const char *manifest_json,
                                                          const char *source_text, uint32_t timeout_ms)
{
    runtime_probe_reload_result_t timeout_result;
    memset(&timeout_result, 0, sizeof(timeout_result));
    timeout_result.kind = RUNTIME_PROBE_RELOAD_TIMEOUT;
    snprintf(timeout_result.reason, sizeof(timeout_result.reason), "timeout");
    if (probe == NULL) return timeout_result;

    bool expected = false;
    if (!atomic_compare_exchange_strong(&probe->reload_in_flight, &expected, true)) {
        return reload_rejected("busy");
    }

    reload_request_t *request = create_reload_request(manifest_json, source_text);
    if (request == NULL) {
        atomic_store(&probe->reload_in_flight, false);
        return reload_rejected("frame");
    }

    reload_request_t *request_ptr = request;
    if (xQueueSend(probe->reload_queue, &request_ptr, 0) != pdTRUE) {
        release_reload_request(request);
        release_reload_request(request);
        atomic_store(&probe->reload_in_flight, false);
        return reload_rejected("busy");
    }

    if (xSemaphoreTake(request->done, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        /* The owner still holds the second reference and will free the copied
         * strings after it has produced its terminal outcome. */
        release_reload_request(request);
        return timeout_result;
    }

    const runtime_probe_reload_result_t result = request->result;
    release_reload_request(request);
    return result;
}

uint32_t runtime_probe_last_generation(runtime_probe_t *probe)
{
    if (probe == NULL) return 0;
    return atomic_load(&probe->cached_last_generation);
}

esp_err_t runtime_probe_start(runtime_probe_t **out_probe)
{
    if (out_probe == NULL) return ESP_ERR_INVALID_ARG;
    *out_probe = NULL;
    if (run_engine_smoke_cycles() != ESP_OK) return ESP_FAIL;

    runtime_probe_t *probe = calloc(1, sizeof(*probe));
    if (probe == NULL) return ESP_ERR_NO_MEM;
    probe->click_dispatch = JS_UNDEFINED;
    probe->pump_fn = JS_UNDEFINED;
    probe->reload_fn = JS_UNDEFINED;
    probe->lastgen_fn = JS_UNDEFINED;
    probe->board_sink = JS_UNDEFINED;
    for (int index = 0; index < (int)TIMER_SLOT_COUNT; index++) probe->timer_slots[index].callback = JS_UNDEFINED;

    probe->event_queue = xQueueCreate(32, sizeof(runtime_probe_event_t));
    probe->reload_queue = xQueueCreate(1, sizeof(reload_request_t *));
    atomic_init(&probe->reload_in_flight, false);
    if (probe->event_queue == NULL || probe->reload_queue == NULL) {
        runtime_probe_destroy(probe);
        return ESP_ERR_NO_MEM;
    }

    probe->runtime = JS_NewRuntime();
    if (probe->runtime == NULL) {
        runtime_probe_destroy(probe);
        return ESP_ERR_NO_MEM;
    }
    JS_SetRuntimeInfo(probe->runtime, "tsx-lvgl-runtime-probe");
    JS_SetMemoryLimit(probe->runtime, ENGINE_MEMORY_LIMIT);
    JS_SetMaxStackSize(probe->runtime, ENGINE_STACK_LIMIT);
    probe->context = JS_NewContext(probe->runtime);
    if (probe->context == NULL) {
        runtime_probe_destroy(probe);
        return ESP_ERR_NO_MEM;
    }
    JS_SetContextOpaque(probe->context, probe);

    probe->lvgl_host = lvgl_host_create(probe_click_from_lvgl, probe);
    if (probe->lvgl_host == NULL) {
        runtime_probe_destroy(probe);
        return ESP_ERR_NO_MEM;
    }

    if (install_native_bindings(probe) != ESP_OK) {
        runtime_probe_destroy(probe);
        return ESP_FAIL;
    }

    for (int slot = 0; slot < (int)TIMER_SLOT_COUNT; slot++) {
        const esp_timer_create_args_t timer_args = {
            .callback = native_timer_fired,
            .arg = (void *)(intptr_t)slot,
            .dispatch_method = ESP_TIMER_TASK,
            .name = TIMER_SLOT_NAMES[slot],
        };
        if (esp_timer_create(&timer_args, &probe->timer_slots[slot].timer) != ESP_OK) {
            runtime_probe_destroy(probe);
            return ESP_FAIL;
        }
    }

    probe->active = true;
    s_active_probe = probe;

    *out_probe = probe;
    JSMemoryUsage usage = {0};
    JS_ComputeMemoryUsage(probe->runtime, &usage);
    char detail[192];
    snprintf(detail, sizeof(detail),
             "engine=quickjs-ng js_malloc=%" PRId64 " js_used=%" PRId64 " free_heap=%u psram_free=%u",
             usage.malloc_size, usage.memory_used_size, (unsigned)free_heap_bytes(),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    log_checkpoint("runtime_start", "pass", detail);
    return ESP_OK;
}

esp_err_t runtime_probe_start_sensors(runtime_probe_t *probe)
{
    if (probe == NULL) return ESP_ERR_INVALID_ARG;
    if (probe->sensors != NULL) return ESP_OK;
    const esp_err_t result = waveshare_v1_sensors_create(bsp_i2c_get_handle(), &probe->sensors);
    log_checkpoint("imu_init", result == ESP_OK ? "pass" : "fail",
                   result == ESP_OK ? "provider=waveshare_v1_sensors cache-task=true" : "provider=waveshare_v1_sensors unavailable");
    return result;
}

esp_err_t runtime_probe_start_connectivity(runtime_probe_t *probe)
{
    if (probe == NULL) return ESP_ERR_INVALID_ARG;
    if (probe->wifi != NULL) return ESP_OK;
    const esp_err_t result = waveshare_v1_wifi_create(&probe->wifi);
    log_checkpoint("wifi_init", result == ESP_OK ? "pass" : "fail",
                   result == ESP_OK ? "provider=waveshare_v1_wifi owner-queue=true credentials=redacted" : "provider=waveshare_v1_wifi unavailable");
    return result;
}

void runtime_probe_destroy(runtime_probe_t *probe)
{
    if (probe == NULL) return;
    probe->active = false;
    if (s_active_probe == probe) s_active_probe = NULL;

    /* Join the I2C task before destroying queues/QuickJS state it may still
     * indirectly service after its bounded 100ms transfer returns. */
    if (probe->sensors != NULL) {
        waveshare_v1_sensors_destroy(probe->sensors);
        probe->sensors = NULL;
    }
    /* Join the station worker before deleting the board/event queues or the
     * QuickJS context it indirectly reaches through the owner loop. */
    if (probe->wifi != NULL) {
        waveshare_v1_wifi_destroy(probe->wifi);
        probe->wifi = NULL;
    }

    for (int slot = 0; slot < (int)TIMER_SLOT_COUNT; slot++) {
        timer_slot_t *entry = &probe->timer_slots[slot];
        if (entry->timer != NULL) {
            (void)esp_timer_stop(entry->timer);
            (void)esp_timer_delete(entry->timer);
            entry->timer = NULL;
        }
        if (probe->context != NULL && !JS_IsUndefined(entry->callback)) JS_FreeValue(probe->context, entry->callback);
        entry->callback = JS_UNDEFINED;
        entry->active = false;
    }

    if (probe->event_queue != NULL) {
        vQueueDelete(probe->event_queue);
        probe->event_queue = NULL;
    }
    if (probe->reload_queue != NULL) {
        reload_request_t *pending = NULL;
        while (xQueueReceive(probe->reload_queue, &pending, 0) == pdTRUE) {
            release_reload_request(pending);
        }
        vQueueDelete(probe->reload_queue);
        probe->reload_queue = NULL;
    }

    if (probe->lvgl_host != NULL) {
        lvgl_host_destroy(probe->lvgl_host);
        probe->lvgl_host = NULL;
    }

    if (probe->context != NULL) {
        if (!JS_IsUndefined(probe->click_dispatch)) JS_FreeValue(probe->context, probe->click_dispatch);
        if (!JS_IsUndefined(probe->pump_fn)) JS_FreeValue(probe->context, probe->pump_fn);
        if (!JS_IsUndefined(probe->reload_fn)) JS_FreeValue(probe->context, probe->reload_fn);
        if (!JS_IsUndefined(probe->lastgen_fn)) JS_FreeValue(probe->context, probe->lastgen_fn);
        if (!JS_IsUndefined(probe->board_sink)) JS_FreeValue(probe->context, probe->board_sink);
        JS_FreeContext(probe->context);
        probe->context = NULL;
    }
    if (probe->runtime != NULL) {
        JS_FreeRuntime(probe->runtime);
        probe->runtime = NULL;
    }
    free(probe);
}
