#include "runtime_probe.h"

#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "lvgl.h"
#include "quickjs.h"

#include "bundle_transport.h"
#include "lvgl_host.h"
#include "waveshare_v1_sensors.h"

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
#define QMI8658_ADDRESS_HIGH 0x6BU
#define QMI8658_ADDRESS_LOW 0x6AU
#define QMI8658_WHO_AM_I_REGISTER 0x00U
#define QMI8658_WHO_AM_I_VALUE 0x05U
#define QMI8658_RESET_REGISTER 0x60U
#define QMI8658_RESET_COMMAND 0xB0U
#define QMI8658_CTRL1_REGISTER 0x02U
#define QMI8658_CTRL2_REGISTER 0x03U
#define QMI8658_CTRL3_REGISTER 0x04U
#define QMI8658_CTRL7_REGISTER 0x08U
#define QMI8658_ACCEL_GYRO_REGISTER 0x35U
#define QMI8658_I2C_SPEED_HZ 400000U
#define QMI8658_I2C_TIMEOUT_MS 100
#define QMI8658_ACCEL_SCALE_MPS2 (9.80665 / 8192.0)
#define QMI8658_GYRO_SCALE_DPS (1.0 / 128.0)

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

    QueueHandle_t event_queue;
    /** Capacity 1: the wire protocol serializes reload attempts (TSXB ERR busy otherwise). */
    QueueHandle_t reload_queue;
    /** Remains true after a caller timeout until the owner releases its request. */
    _Atomic bool reload_in_flight;
    _Atomic uint32_t cached_last_generation;

    waveshare_v1_sensors_t *sensors;
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

extern const uint8_t _binary_kernel_js_start[] asm("_binary_kernel_js_start");
extern const uint8_t _binary_kernel_js_end[] asm("_binary_kernel_js_end");
extern const uint8_t _binary_shakeface_g1_js_start[] asm("_binary_shakeface_g1_js_start");
extern const uint8_t _binary_shakeface_g1_manifest_json_start[] asm("_binary_shakeface_g1_manifest_json_start");

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

static void dump_exception(JSContext *context, const char *checkpoint)
{
    JSValue exception = JS_GetException(context);
    const char *message = JS_ToCString(context, exception);
    if (message == NULL) {
        ESP_LOGE(TAG, "PROBE checkpoint=%s status=fail error=<unprintable>", checkpoint);
    } else {
        ESP_LOGE(TAG, "PROBE checkpoint=%s status=fail error=%s", checkpoint, message);
        JS_FreeCString(context, message);
    }
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

/* Retired direct I2C path: the provider component owns all QMI transactions. */
#if 0

static esp_err_t qmi8658_write_register(runtime_probe_t *probe, uint8_t reg, uint8_t value)
{
    const uint8_t command[] = {reg, value};
    return i2c_master_transmit(probe->imu_device, command, sizeof(command), QMI8658_I2C_TIMEOUT_MS);
}

static esp_err_t qmi8658_read_registers(runtime_probe_t *probe, uint8_t reg, uint8_t *data, size_t length)
{
    return i2c_master_transmit_receive(probe->imu_device, &reg, sizeof(reg), data, length, QMI8658_I2C_TIMEOUT_MS);
}

static int16_t qmi8658_signed_sample(const uint8_t *data, size_t offset)
{
    const uint16_t raw = (uint16_t)data[offset] | ((uint16_t)data[offset + 1U] << 8U);
    return (int16_t)raw;
}

static esp_err_t initialize_qmi8658(runtime_probe_t *probe)
{
    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    if (bus == NULL) return ESP_ERR_INVALID_STATE;

    const uint8_t candidates[] = {QMI8658_ADDRESS_HIGH, QMI8658_ADDRESS_LOW};
    for (size_t index = 0; index < sizeof(candidates); index++) {
        const uint8_t address = candidates[index];
        if (i2c_master_probe(bus, address, QMI8658_I2C_TIMEOUT_MS) != ESP_OK) continue;

        const i2c_device_config_t device_config = {
            .dev_addr_length = I2C_ADDR_BIT_LEN_7,
            .device_address = address,
            .scl_speed_hz = QMI8658_I2C_SPEED_HZ,
        };
        i2c_master_dev_handle_t device = NULL;
        esp_err_t result = i2c_master_bus_add_device(bus, &device_config, &device);
        if (result != ESP_OK) continue;

        uint8_t who_am_i = 0;
        result = i2c_master_transmit_receive(device, (uint8_t[]){QMI8658_WHO_AM_I_REGISTER}, 1, &who_am_i, 1,
                                             QMI8658_I2C_TIMEOUT_MS);
        if (result != ESP_OK || who_am_i != QMI8658_WHO_AM_I_VALUE) {
            (void)i2c_master_bus_rm_device(device);
            continue;
        }

        probe->imu_device = device;
        probe->imu_address = address;
        result = qmi8658_write_register(probe, QMI8658_RESET_REGISTER, QMI8658_RESET_COMMAND);
        if (result == ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(20));
            result = qmi8658_write_register(probe, QMI8658_CTRL1_REGISTER, 0x60U);
        }
        if (result == ESP_OK) result = qmi8658_write_register(probe, QMI8658_CTRL2_REGISTER, 0x15U);
        if (result == ESP_OK) result = qmi8658_write_register(probe, QMI8658_CTRL3_REGISTER, 0x45U);
        if (result == ESP_OK) result = qmi8658_write_register(probe, QMI8658_CTRL7_REGISTER, 0x03U);
        if (result != ESP_OK) {
            (void)i2c_master_bus_rm_device(probe->imu_device);
            probe->imu_device = NULL;
            continue;
        }

        probe->imu_ready = true;
        char detail[96];
        snprintf(detail, sizeof(detail), "sensor=qmi8658 addr=0x%02x who_am_i=0x%02x", probe->imu_address, who_am_i);
        log_checkpoint("imu_init", "pass", detail);
        return ESP_OK;
    }

    return ESP_ERR_NOT_FOUND;
}

#endif
/* --- __native binding surface (packages/device/src/native.ts is the normative contract) --- */

static JSValue js_console_log(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv)
{
    (void)this_value;
    char message[256] = {0};
    size_t used = 0;
    for (int index = 0; index < argc && used + 1 < sizeof(message); index++) {
        const char *part = JS_ToCString(context, argv[index]);
        if (part == NULL) continue;
        const int written = snprintf(message + used, sizeof(message) - used, "%s%s", index == 0 ? "" : " ", part);
        JS_FreeCString(context, part);
        if (written <= 0) break;
        used += (size_t)written;
        if (used >= sizeof(message)) {
            used = sizeof(message) - 1;
            message[used] = '\0';
        }
    }
    ESP_LOGI(TAG, "JS %s", message);
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
    if (!waveshare_v1_sensors_read_motion(probe->sensors, &frame)) {
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

    JS_SetPropertyStr(context, native, "onClick", JS_NewCFunction(context, js_native_on_click, "onClick", 1));
    JS_SetPropertyStr(context, native, "log", JS_NewCFunction(context, js_native_log, "log", 1));

    JS_SetPropertyStr(context, global, "__native", native);
    JS_FreeValue(context, global);
    return ESP_OK;
}

/* --- Boot: evaluate kernel.js, then mount the baked-in ShakeFace bundle (generation 1) --- */

static esp_err_t boot_kernel_and_app(runtime_probe_t *probe)
{
    JSContext *context = probe->context;
    const size_t kernel_length = (size_t)(_binary_kernel_js_end - _binary_kernel_js_start);
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

    JSValue manifest_value = JS_NewString(context, (const char *)_binary_shakeface_g1_manifest_json_start);
    JSValue source_value = JS_NewString(context, (const char *)_binary_shakeface_g1_js_start);
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
    log_checkpoint("app_mount", "pass", "bundle=shakeface generation=1");

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

    if (boot_kernel_and_app(probe) != ESP_OK) {
        s_active_probe = NULL;
        runtime_probe_destroy(probe);
        return ESP_FAIL;
    }

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

void runtime_probe_destroy(runtime_probe_t *probe)
{
    if (probe == NULL) return;
    probe->active = false;
    if (s_active_probe == probe) s_active_probe = NULL;

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

    if (probe->sensors != NULL) {
        waveshare_v1_sensors_destroy(probe->sensors);
        probe->sensors = NULL;
    }

    if (probe->context != NULL) {
        if (!JS_IsUndefined(probe->click_dispatch)) JS_FreeValue(probe->context, probe->click_dispatch);
        if (!JS_IsUndefined(probe->pump_fn)) JS_FreeValue(probe->context, probe->pump_fn);
        if (!JS_IsUndefined(probe->reload_fn)) JS_FreeValue(probe->context, probe->reload_fn);
        if (!JS_IsUndefined(probe->lastgen_fn)) JS_FreeValue(probe->context, probe->lastgen_fn);
        JS_FreeContext(probe->context);
        probe->context = NULL;
    }
    if (probe->runtime != NULL) {
        JS_FreeRuntime(probe->runtime);
        probe->runtime = NULL;
    }
    free(probe);
}
