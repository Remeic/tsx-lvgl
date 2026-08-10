import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../examples/esp-idf/runtime_port_probe/main/runtime_probe.c", import.meta.url), "utf8");
const appMain = readFileSync(new URL("../examples/esp-idf/runtime_port_probe/main/app_main.c", import.meta.url), "utf8");
const component = readFileSync(new URL("../examples/esp-idf/runtime_port_probe/components/waveshare_v1_wifi/waveshare_v1_wifi.c", import.meta.url), "utf8");
const mainCmake = readFileSync(new URL("../examples/esp-idf/runtime_port_probe/main/CMakeLists.txt", import.meta.url), "utf8");

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
