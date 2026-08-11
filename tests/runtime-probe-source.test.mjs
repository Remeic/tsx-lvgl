import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../examples/esp-idf/runtime_port_probe/main/runtime_probe.c", import.meta.url), "utf8");
const transport = readFileSync(new URL("../examples/esp-idf/runtime_port_probe/main/bundle_transport.c", import.meta.url), "utf8");
const appMain = readFileSync(new URL("../examples/esp-idf/runtime_port_probe/main/app_main.c", import.meta.url), "utf8");
const lvglHost = readFileSync(new URL("../examples/esp-idf/runtime_port_probe/main/lvgl_host.c", import.meta.url), "utf8");
const component = readFileSync(new URL("../examples/esp-idf/runtime_port_probe/components/waveshare_v1_wifi/waveshare_v1_wifi.c", import.meta.url), "utf8");
const mainCmake = readFileSync(new URL("../examples/esp-idf/runtime_port_probe/main/CMakeLists.txt", import.meta.url), "utf8");
const checker = readFileSync(new URL("../tools/check-runtime-probe.mjs", import.meta.url), "utf8");
const kernelBuilder = readFileSync(new URL("../scripts/build-kernel.mjs", import.meta.url), "utf8");
const displayStartup = existsSync(new URL("../examples/esp-idf/runtime_port_probe/main/display_startup.c", import.meta.url))
  ? readFileSync(new URL("../examples/esp-idf/runtime_port_probe/main/display_startup.c", import.meta.url), "utf8")
  : "";

function createReservationFence(slotCount = 4) {
  let nextReservation = 0;
  const slots = Array.from({ length: slotCount }, () => null);
  const queued = [];
  return {
    submit(correlationId) {
      const slotIndex = slots.findIndex((slot) => slot === null);
      if (slotIndex < 0) return null;
      const entry = { correlationId, reservation: ++nextReservation, slotIndex };
      slots[slotIndex] = { ...entry, cancelled: false };
      queued.push(entry);
      return entry;
    },
    dequeue() { return queued.shift() ?? null; },
    cancel(correlationId) {
      for (const slot of slots) if (slot?.correlationId === correlationId) slot.cancelled = true;
      for (let index = queued.length - 1; index >= 0; index--) {
        const entry = queued[index];
        if (entry.correlationId !== correlationId) continue;
        slots[entry.slotIndex] = null;
        queued.splice(index, 1);
      }
    },
    consume(entry) {
      const slot = slots[entry.slotIndex];
      if (slot === null || slot.reservation !== entry.reservation || slot.correlationId !== entry.correlationId) return false;
      slots[entry.slotIndex] = null;
      return !slot.cancelled;
    },
    reservedCount() { return slots.filter(Boolean).length; },
  };
}

test("runtime probe trims the ESP-IDF embedded kernel terminator before QuickJS evaluation", () => {
  assert.match(source, /size_t kernel_length = \(size_t\)\(_binary_kernel_js_end - _binary_kernel_js_start\);/);
  assert.match(source, /if \(kernel_length > 0U && _binary_kernel_js_start\[kernel_length - 1U\] == '\\0'\) kernel_length--;/);
  assert.match(kernelBuilder, /const KERNEL_BUDGET_BYTES = 128 \* 1024;/);
  assert.match(kernelBuilder, /finalBytes > KERNEL_BUDGET_BYTES/);
});

test("native runtime diagnostics are bounded metadata and never stringify payloads", () => {
  const consoleLog = source.match(/static JSValue js_console_log\([\s\S]*?\n}\n\nstatic const char \*widget_kind_name/);
  assert.ok(consoleLog, "console log binding must remain present");
  assert.doesNotMatch(consoleLog[0], /JS_ToCString|message|%s/);
  assert.match(source, /error=js-exception/);
  assert.match(source, /class=%s/);
  assert.match(source, /line=%u/);
  assert.doesNotMatch(transport, /frame_error tag=%\.\*s/);
  assert.match(transport, /frame_error tag_length=%u/);
  assert.match(transport, /snprintf\(pattern, sizeof\(pattern\), "\\\"%s\\\":"/);
  assert.match(transport, /while \(\*at == ' ' \|\| \*at == '\\t'/);
});

test("display startup owns one bounded FT3168 recovery path and keeps SH8601 alive", () => {
  assert.match(mainCmake, /display_startup\.c/);
  assert.match(displayStartup, /bsp_i2c_init\(\)/);
  assert.match(displayStartup, /i2c_master_bus_handle_t bus = bsp_i2c_get_handle\(\);/);
  assert.match(displayStartup, /i2c_master_bus_reset\(bus\)/);
  assert.match(displayStartup, /WAVESHARE_V1_TOUCH_INIT_ATTEMPTS/);
  assert.match(displayStartup, /esp_lcd_touch_new_i2c_ft5x06/);
  assert.match(displayStartup, /lvgl_port_add_touch/);
  assert.match(displayStartup, /esp_lcd_panel_io_del\(touch_io\)/);
  assert.match(displayStartup, /lvgl_port_add_disp_rgb/);
  assert.doesNotMatch(displayStartup, /bsp_display_start\(/);
  assert.doesNotMatch(displayStartup, /i2c_new_master_bus\(/);
  assert.match(appMain, /waveshare_v1_display_start\(\)/);
  assert.doesNotMatch(appMain, /ESP_ERROR_CHECK\(bsp_display_brightness_set/);
});

test("native root replacement forces the first LVGL frame while the owner lock is held", () => {
  assert.match(lvglHost, /lv_screen_load\(entry->object\);[\s\S]*lv_refr_now\(lv_display_get_default\(\)\);/);
  assert.match(lvglHost, /lv_screen_load\(host->blank_screen\);[\s\S]*lv_refr_now\(lv_display_get_default\(\)\);/);
});

test("optional providers report unavailable state without aborting application boot", () => {
  assert.match(appMain, /const esp_err_t sensors_result = runtime_probe_start_sensors\(probe\);/);
  assert.match(appMain, /const esp_err_t connectivity_result = runtime_probe_start_connectivity\(probe\);/);
  assert.match(appMain, /status=unavailable/);
  assert.match(appMain, /#define RUNTIME_PROBE_BOOT_STACK_WORDS \(12288U\)/);
  assert.doesNotMatch(appMain, /xTaskCreate\(runtime_probe_task/);
  assert.match(appMain, /runtime_probe_task\(probe\);/);
  assert.ok(appMain.indexOf("bundle_transport_start(probe)") < appMain.indexOf("runtime_probe_start_sensors(probe)"));
  assert.ok(appMain.indexOf("runtime_probe_start_connectivity(probe)") < appMain.indexOf("runtime_probe_boot(probe)"));
  assert.doesNotMatch(appMain, /if \(runtime_probe_start_sensors\(probe\)/);
  assert.doesNotMatch(appMain, /if \(runtime_probe_start_connectivity\(probe\)/);
  assert.doesNotMatch(source, /probe == NULL \|\| probe->sensors == NULL \|\| probe->wifi == NULL/);
  assert.match(source, /if \(probe->sensors == NULL\) \{/);
  assert.match(source, /static void log_sensor_checkpoint\(runtime_probe_t \*probe, bool available\)/);
  assert.match(source, /log_sensor_checkpoint\(probe, available\);/);
});

test("UART acceptance keeps optional touch and motion capability checks fail-soft", () => {
  assert.match(checker, /const optionalCapabilities = new Map\(\[/);
  assert.match(checker, /\[\"imu_init\", new Set\(\[\"pass\", \"unavailable\"\]\)\]/);
  assert.match(checker, /\[\"sensor_read\", new Set\(\[\"pass\", \"unavailable\"\]\)\]/);
  assert.match(checker, /\"display_init\"/);
  assert.match(checker, /\"touch_init\"/);
  assert.match(transport, /#define BUNDLE_TRANSPORT_STACK_WORDS \(8192U\)/);
  assert.match(transport, /xTaskCreate\(bundle_transport_task, \"bundle_transport\", BUNDLE_TRANSPORT_STACK_WORDS/);
});

test("runtime probe submits the bounded motion period to the QMI cache provider", () => {
  assert.match(source, /JSValue period = JS_GetPropertyStr\(context, argv\[0\], "periodMs"\);/);
  assert.match(source, /waveshare_v1_sensors_set_period_ms\(probe->sensors, \(uint32_t\)period_ms\)/);
});

test("runtime probe builds each motion event from the snapshot it already read", () => {
  const eventFactory = source.match(/static JSValue new_board_event\([\s\S]*?\n}\n\nstatic JSValue js_native_board_list/);
  assert.ok(eventFactory, "motion event factory must remain present");
  assert.doesNotMatch(eventFactory[0], /waveshare_v1_sensors_read_motion/);
  assert.match(source, /new_board_event\(probe->context, probe, probe->board_handle, probe->board_reload_epoch, &frame, true\)/);
});

test("runtime probe installs Wi-Fi through the existing board owner queue before app boot", () => {
  assert.match(mainCmake, /waveshare_v1_wifi/);
  assert.match(source, /JS_SetPropertyStr\(context, native, "board", board\)/);
  assert.doesNotMatch(source, /JS_SetPropertyStr\(context, native, "wifi"/);
  assert.match(source, /emit_wifi_events\(probe\);/);
  assert.match(source, /"instanceId", JS_NewString\(context, "wifi\.station"\)/);
  assert.match(source, /"correlationId"/);
  assert.ok(appMain.indexOf("runtime_probe_start_connectivity(probe)") < appMain.indexOf("runtime_probe_boot(probe)"));
});

test("Wi-Fi provider keeps build-local credentials redacted and joins its worker before teardown", () => {
  assert.match(component, /esp_wifi_set_storage\(WIFI_STORAGE_RAM\)/);
  assert.match(component, /memset\(&config, 0, sizeof\(config\)\)/);
  assert.match(component, /WIFI_CONNECT_TIMEOUT_MS/);
  assert.match(component, /IP_EVENT_STA_GOT_IP/);
  assert.match(component, /xSemaphoreTake\(wifi->stopped, pdMS_TO_TICKS\(WIFI_TASK_STOP_TIMEOUT_MS\)\)/);
  assert.match(component, /vTaskDelete\(NULL\)/);
  assert.doesNotMatch(component, /ESP_LOG[IEW].*CONFIG_TSX_LVGL_WIFI_STATION_/);
  assert.match(source, /credentials=redacted/);
  const destroy = component.match(/void waveshare_v1_wifi_destroy\([\s\S]*?\n}\n\nesp_err_t waveshare_v1_wifi_submit/);
  assert.ok(destroy, "Wi-Fi destroy implementation must remain present");
  assert.ok(destroy[0].indexOf("xSemaphoreTake") < destroy[0].indexOf("wifi->active = false"));
  assert.ok(destroy[0].indexOf("wifi->active = false") < destroy[0].indexOf("esp_event_handler_unregister"));
  assert.ok(destroy[0].indexOf("esp_event_handler_unregister") < destroy[0].indexOf("vQueueDelete"));
});

test("Wi-Fi queue exhaustion and lost events remain bounded and terminal without identity data", () => {
  assert.match(component, /WIFI_OVERFLOW_QUEUE_DEPTH/);
  assert.match(component, /xQueueOverwrite\(wifi->overflows/);
  assert.match(component, /wifi-event-queue-full/);
  assert.match(component, /ESP_ERR_TIMEOUT/);
  assert.match(source, /wifi-command-queue-full/);
  assert.match(source, /WIFI_OWNER_OPERATION_TIMEOUT_MS/);
  assert.match(source, /static void expire_wifi_operations/);
  assert.match(source, /expire_wifi_operations\(probe\);/);
  assert.match(source, /wifi-owner-timeout/);
  assert.match(source, /"resource-exhausted"/);
  assert.doesNotMatch(source, /"ssid"|"passphrase"/i);
});

test("Wi-Fi cancellation fences commands already dequeued or waiting in the provider queue", () => {
  assert.match(component, /SemaphoreHandle_t command_lock/);
  assert.match(component, /mark_cancelled_command/);
  assert.match(component, /purge_cancelled_command/);
  assert.match(component, /take_command_slot/);
  assert.match(component, /xSemaphoreTake\(wifi->command_lock, portMAX_DELAY\)/);
  assert.match(component, /if \(!wifi->active\) \{[\s\S]*break;/);
  const cancel = component.match(/void waveshare_v1_wifi_cancel\([\s\S]*?\n}\n\nbool waveshare_v1_wifi_take_event/);
  assert.ok(cancel, "Wi-Fi cancellation implementation must remain present");
  assert.ok(cancel[0].indexOf("mark_cancelled_command") < cancel[0].indexOf("purge_cancelled_command"));
  assert.ok(cancel[0].indexOf("purge_cancelled_command") < cancel[0].indexOf("xSemaphoreGive"));
});

test("Wi-Fi cancellation uses reclaimable command reservations beyond queue-depth cancellations", () => {
  const fence = createReservationFence();
  for (let correlationId = 1; correlationId <= 5; correlationId++) {
    assert.ok(fence.submit(correlationId), `cancellation ${correlationId} must reserve a slot`);
    fence.cancel(correlationId);
    assert.equal(fence.reservedCount(), 0, `cancellation ${correlationId} must reclaim its reservation`);
  }
  assert.doesNotMatch(component, /cancelled_correlations/);
  assert.match(component, /wifi_command_slot_t command_slots\[WIFI_COMMAND_QUEUE_DEPTH\]/);
  assert.match(component, /static bool reserve_command_slot[\s\S]*?if \(slot->reserved\) continue;/);
  assert.match(component, /static void release_command_slot[\s\S]*?memset\(&wifi->command_slots/);
  const purge = component.match(/static void purge_cancelled_command[\s\S]*?\n}\n\nstatic bool send_event/);
  assert.ok(purge, "queue purge must remain present");
  assert.match(purge[0], /entry\.correlation_id == correlation_id[\s\S]*?release_command_slot\(wifi, &entry\)/);
});

test("Wi-Fi dequeued-before-cancel race consumes a marked reservation before side effects", () => {
  const fence = createReservationFence();
  const dequeued = fence.submit(99);
  assert.ok(dequeued);
  assert.deepEqual(fence.dequeue(), dequeued);
  fence.cancel(99);
  assert.equal(fence.consume(dequeued), false, "a command dequeued before cancellation must not run");
  assert.equal(fence.reservedCount(), 0);
  const worker = component.match(/static void wifi_task[\s\S]*?\n}\n\nesp_err_t waveshare_v1_wifi_create/);
  assert.ok(worker, "Wi-Fi worker must remain present");
  assert.ok(worker[0].indexOf("xQueueReceive") < worker[0].indexOf("xSemaphoreTake(wifi->command_lock"));
  assert.ok(worker[0].indexOf("xSemaphoreTake(wifi->command_lock") < worker[0].indexOf("take_command_slot(wifi, &command)"));
  assert.match(worker[0], /if \(received && take_command_slot\(wifi, &command\)\) switch \(command\.command\)/);
  const consume = component.match(/static bool take_command_slot[\s\S]*?\n}\n\nstatic void mark_cancelled_command/);
  assert.ok(consume, "reservation consumer must remain present");
  assert.ok(consume[0].indexOf("!wifi->command_slots[command->slot_index].cancelled") < consume[0].indexOf("release_command_slot"));
});
