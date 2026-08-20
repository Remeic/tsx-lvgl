import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import boardCatalog from "../packages/sdk/src/board-catalog.json" with { type: "json" };
import { NATIVE_STYLE_PROP } from "../packages/device/dist/style.js";
import { resolveBoardProfile } from "../scripts/board-profile.mjs";

const source = readFileSync(new URL("../examples/esp-idf/components/tsx_runtime_probe/runtime_probe.c", import.meta.url), "utf8");
const runtimeHeader = readFileSync(new URL("../examples/esp-idf/components/tsx_runtime_probe/include/runtime_probe.h", import.meta.url), "utf8");
const transport = readFileSync(new URL("../examples/esp-idf/components/tsx_runtime_probe/bundle_transport.c", import.meta.url), "utf8");
const transportHeader = readFileSync(new URL("../examples/esp-idf/components/tsx_runtime_probe/include/bundle_transport.h", import.meta.url), "utf8");
const appMain = readFileSync(new URL("../examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/main/app_main.c", import.meta.url), "utf8");
const lvglHost = readFileSync(new URL("../examples/esp-idf/components/tsx_runtime_probe/lvgl_host.c", import.meta.url), "utf8");
const component = readFileSync(new URL("../examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/components/waveshare_v1_wifi/waveshare_v1_wifi.c", import.meta.url), "utf8");
const mainCmake = readFileSync(new URL("../examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/main/CMakeLists.txt", import.meta.url), "utf8");
const runtimeCmake = readFileSync(new URL("../examples/esp-idf/components/tsx_runtime_probe/CMakeLists.txt", import.meta.url), "utf8");
const adapterCmake = readFileSync(new URL("../examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/components/tsx_board_adapter_v1/CMakeLists.txt", import.meta.url), "utf8");
const adapterSource = readFileSync(new URL("../examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/components/tsx_board_adapter_v1/tsx_board_adapter_v1.c", import.meta.url), "utf8");
const adapterContract = readFileSync(new URL("../examples/esp-idf/components/tsx_board_adapter/include/tsx_board_adapter.h", import.meta.url), "utf8");
const targetReadme = readFileSync(new URL("../examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/README.md", import.meta.url), "utf8");
const checker = readFileSync(new URL("../tools/check-runtime-probe.mjs", import.meta.url), "utf8");
const kernelBuilder = readFileSync(new URL("../scripts/build-kernel.mjs", import.meta.url), "utf8");
const targetIdGenerator = readFileSync(new URL("../scripts/generate-board-target-id.mjs", import.meta.url), "utf8");
const embedRuntimeApp = readFileSync(new URL("../scripts/embed-runtime-app.mjs", import.meta.url), "utf8");
const displayStartup = existsSync(new URL("../examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/components/tsx_board_adapter_v1/display_startup.c", import.meta.url))
  ? readFileSync(new URL("../examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/components/tsx_board_adapter_v1/display_startup.c", import.meta.url), "utf8")
  : "";
const lvglHostHeader = readFileSync(new URL("../examples/esp-idf/components/tsx_runtime_probe/include/lvgl_host.h", import.meta.url), "utf8");
const target = resolveBoardProfile("waveshare-touch-amoled-1.8-v1", resolve(new URL("..", import.meta.url).pathname));
const embeddedManifest = JSON.parse(readFileSync(target.embeddedAppManifestPath, "utf8"));
const shakefaceManifest = JSON.parse(readFileSync(new URL("../examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/main/shakeface.g1.manifest.json", import.meta.url), "utf8"));

/** SCREAMING_SNAKE_CASE -> camelCase, e.g. "BACKGROUND_COLOR" -> "backgroundColor". */
function toCamelCase(screamingSnakeCase) {
  return screamingSnakeCase
    .toLowerCase()
    .split("_")
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

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
  assert.match(runtimeHeader, /runtime_probe_assets_t/);
  assert.match(source, /size_t kernel_length = \(size_t\)\(probe->assets\.kernel_end - probe->assets\.kernel_start\);/);
  assert.match(source, /if \(kernel_length > 0U && probe->assets\.kernel_start\[kernel_length - 1U\] == '\\0'\) kernel_length--;/);
  assert.match(appMain, /_binary_kernel_js_end/);
  assert.match(kernelBuilder, /const KERNEL_BUDGET_BYTES = 128 \* 1024;/);
  assert.match(kernelBuilder, /finalBytes > KERNEL_BUDGET_BYTES/);
});

test("runtime probe uses stable embedded-app filenames so the app can change without C edits", () => {
  assert.match(mainCmake, /EMBED_TXTFILES "kernel\.js" "app\.g1\.js" "app\.g1\.manifest\.json"/);
  assert.match(appMain, /_binary_app_g1_js_start/);
  assert.match(appMain, /_binary_app_g1_manifest_json_start/);
  assert.match(embedRuntimeApp, /always use the stable app\.g1\.\* names/);
});

test("selected V1 target and committed embedded manifest share the canonical identity", () => {
  const catalogBoard = boardCatalog.boards.find((board) => board.id === target.boardId);
  assert.ok(catalogBoard, `catalog must contain target board ${target.boardId}`);
  assert.equal(target.boardId, catalogBoard.id);
  assert.equal(embeddedManifest.boardId, catalogBoard.id);
  assert.equal(shakefaceManifest.boardId, catalogBoard.id);
  assert.match(adapterSource, /TSX_BOARD_TARGET_ID/);
  assert.match(adapterCmake, /tsx_board_target_id\.h/);
  assert.match(adapterContract, /const char \*\(\*target_id\)/);
  assert.match(targetIdGenerator, /profile\.boardId/);
  assert.match(targetIdGenerator, /TSX_BOARD_TARGET_ID/);
  assert.doesNotMatch(adapterSource, /waveshare\.esp32s3\.touch-amoled-1\.8\.v1/);
});

test("shared runtime component has no target BSP or provider dependency", () => {
  const sharedSources = [runtimeHeader, source, transportHeader, transport, lvglHost, lvglHostHeader, runtimeCmake].join("\n");
  assert.doesNotMatch(sharedSources, /waveshare_v1|WAVESHARE_V1|bsp\//);
  assert.doesNotMatch(runtimeCmake, /waveshare|bsp|provider/i);
  assert.match(adapterSource, /bsp\/esp32_s3_touch_amoled_1_8\.h/);
  assert.match(adapterSource, /waveshare_v1_sensors\.h/);
  assert.match(adapterSource, /waveshare_v1_wifi\.h/);
  assert.match(adapterCmake, /if\(NOT EXISTS[\s\S]*tsx_board_target_id\.h/);
  assert.match(adapterCmake, /message\(FATAL_ERROR/);
  assert.match(adapterSource, /static const tsx_board_adapter_t adapter/);
  assert.match(adapterSource, /static esp_err_t v1_probe_identity\(void \*context, tsx_board_identity_result_t \*out_result\)/);
  assert.match(adapterSource, /\*out_result = TSX_BOARD_IDENTITY_COMPILE_TIME_ACCEPTED;/);
  assert.match(adapterSource, /\*out_result = TSX_BOARD_IDENTITY_COMPILE_TIME_ACCEPTED;[\s\S]*return ESP_OK;/);
  assert.match(adapterContract, /TSX_BOARD_IDENTITY_COMPILE_TIME_ACCEPTED/);
  assert.match(adapterContract, /probe_identity\)\(void \*context, tsx_board_identity_result_t \*out_result\)/);
  assert.match(targetReadme, /TSX_BOARD_IDENTITY_COMPILE_TIME_ACCEPTED/);
  assert.match(targetReadme, /does not observe physical identity or\s+gate readiness/);
});

test("the shared owner entry owns bootstrap, loop, and lock-scoped cleanup", () => {
  assert.match(runtimeHeader, /esp_err_t runtime_probe_run\(const tsx_board_adapter_t \*board/);
  assert.match(source, /esp_err_t runtime_probe_run\(const tsx_board_adapter_t \*board/);
  assert.match(appMain, /runtime_probe_run\(board, &RUNTIME_ASSETS\)/);
  assert.doesNotMatch(appMain, /bundle_transport_start|runtime_probe_start_sensors|runtime_probe_start_connectivity|runtime_probe_boot|runtime_probe_destroy/);
  assert.doesNotMatch(runtimeHeader, /runtime_probe_destroy/);
  assert.doesNotMatch(source, /runtime_probe_destroy_impl|lvgl_host_discard_without_lvgl/);
  assert.match(source, /RUNTIME_PROBE_CLEANUP_RETRY_RESTART/);
  assert.match(source, /RUNTIME_PROBE_CLEANUP_RETRY_RETURN_RESULT/);
  assert.match(source, /const esp_err_t transport_result = bundle_transport_start\(probe\);[\s\S]*const esp_err_t sensors_result = runtime_probe_start_sensors\(probe\);[\s\S]*const esp_err_t connectivity_result = runtime_probe_start_connectivity\(probe\);/);
  assert.match(source, /runtime_probe_task\(probe\);\s*return runtime_probe_cleanup\(probe, RUNTIME_PROBE_CLEANUP_RETRY_RETURN_RESULT, ESP_OK\);/);
  assert.match(source, /runtime_probe_stop_transport\(probe\);[\s\S]*tsx_board_adapter_display_lock\(board, 0\)/);
  assert.match(source, /runtime_probe_destroy_lvgl_locked\(probe\);\s*tsx_board_adapter_display_unlock\(board\);\s*[\s\S]*runtime_probe_release_resources\(probe\);/);
  assert.match(source, /s_pending_cleanup = \(runtime_probe_pending_cleanup_t\) \{[\s\S]*cleanup=retained/);
  assert.match(source, /const runtime_probe_pending_cleanup_t pending = s_pending_cleanup;[\s\S]*if \(pending\.retry == RUNTIME_PROBE_CLEANUP_RETRY_RETURN_RESULT\) return pending\.result;/);
  assert.match(source, /if \(pending\.retry == RUNTIME_PROBE_CLEANUP_RETRY_RETURN_RESULT\) return pending\.result;[\s\S]*runtime_probe_start\(board, assets, &probe\)/);
  assert.match(source, /runtime_probe_cleanup\(\s*probe, RUNTIME_PROBE_CLEANUP_RETRY_RESTART, ESP_OK\)[\s\S]*if \(cleanup_result != ESP_OK\) return cleanup_result;[\s\S]*continue;/);
  assert.match(source, /runtime_probe_cleanup\(\s*probe, RUNTIME_PROBE_CLEANUP_RETRY_RETURN_RESULT, result\)[\s\S]*if \(cleanup_result != ESP_OK\) return cleanup_result;[\s\S]*return result;/);
  assert.match(source, /memset\(&s_pending_cleanup, 0, sizeof\(s_pending_cleanup\)\);\s*runtime_probe_release_resources\(probe\);/);
  assert.doesNotMatch(source, /\(void\)runtime_probe_cleanup/);
  assert.match(lvglHostHeader, /lvgl_host_destroy/);
  assert.match(lvglHost, /void lvgl_host_destroy\(lvgl_host_t \*host\)/);
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

test("reload responses stay within the documented TSXB error vocabulary", () => {
  assert.match(source, /static bool is_runtime_rejection_reason\(const char \*reason\)/);
  assert.match(source, /strncmp\(status, "rejected ", 9\) == 0 && is_runtime_rejection_reason\(status \+ 9\)/);
  assert.match(source, /outcome\.kind = RUNTIME_PROBE_RELOAD_ROLLED_BACK;/);
  assert.match(source, /reason=evaluate-rolled-back/);
  assert.doesNotMatch(source, /snprintf\(outcome\.reason, sizeof\(outcome\.reason\), "js-exception"/);
  assert.doesNotMatch(source, /snprintf\(outcome\.reason, sizeof\(outcome\.reason\), "unprintable-status"/);
});

test("display startup owns one bounded FT3168 recovery path and keeps SH8601 alive", () => {
  assert.match(adapterCmake, /display_startup\.c/);
  assert.match(displayStartup, /bsp_i2c_init\(\)/);
  assert.match(displayStartup, /i2c_master_bus_handle_t bus = bsp_i2c_get_handle\(\);/);
  assert.match(displayStartup, /i2c_master_bus_reset\(bus\)/);
  assert.match(displayStartup, /WAVESHARE_V1_TOUCH_INIT_ATTEMPTS/);
  assert.match(displayStartup, /esp_lcd_touch_new_i2c_ft5x06/);
  assert.match(displayStartup, /lvgl_port_add_touch/);
  assert.match(displayStartup, /esp_lcd_panel_io_del\(touch_io\)/);
  assert.match(displayStartup, /lvgl_port_add_disp\(&display_config_lvgl\)/);
  assert.doesNotMatch(displayStartup, /lvgl_port_add_disp_rgb/);
  assert.doesNotMatch(displayStartup, /bsp_display_start\(/);
  assert.doesNotMatch(displayStartup, /i2c_new_master_bus\(/);
  assert.match(appMain, /tsx_board_adapter_display_start\(board\)/);
  assert.doesNotMatch(appMain, /ESP_ERROR_CHECK\(bsp_display_brightness_set/);
});

test("native root replacement forces the first LVGL frame while the owner lock is held", () => {
  assert.match(lvglHost, /lv_screen_load\(entry->object\);[\s\S]*lv_refr_now\(lv_display_get_default\(\)\);/);
  assert.match(lvglHost, /lv_screen_load\(host->blank_screen\);[\s\S]*lv_refr_now\(lv_display_get_default\(\)\);/);
});

test("native host stages non-screen widgets under a real LVGL parent", () => {
  assert.match(lvglHost, /lv_obj_t \*staging_screen;/);
  assert.match(lvglHost, /host->staging_screen = lv_obj_create\(NULL\);/);
  assert.match(lvglHost, /object = lv_obj_create\(staging\);/);
  assert.match(lvglHost, /object = lv_label_create\(staging\);/);
  assert.match(lvglHost, /object = lv_button_create\(staging\);/);
  assert.doesNotMatch(lvglHost, /object = lv_label_create\(NULL\);/);
  assert.doesNotMatch(lvglHost, /object = lv_button_create\(NULL\);/);
  assert.match(lvglHost, /lv_obj_delete\(host->staging_screen\);/);
});

test("native host gives Screen and View a centered vertical layout", () => {
  assert.match(lvglHost, /lv_obj_set_flex_flow\(object, LV_FLEX_FLOW_COLUMN\);/);
  assert.match(lvglHost, /lv_obj_set_flex_align\(object, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER\);/);
  assert.match(lvglHost, /configure_container\(object\);/);
});

test("optional providers report unavailable state without aborting application boot", () => {
  assert.match(source, /const esp_err_t sensors_result = runtime_probe_start_sensors\(probe\);/);
  assert.match(source, /const esp_err_t connectivity_result = runtime_probe_start_connectivity\(probe\);/);
  assert.match(source, /status=unavailable/);
  assert.match(appMain, /#define RUNTIME_PROBE_BOOT_STACK_WORDS \(32768U\)/);
  assert.doesNotMatch(appMain, /xTaskCreate\(runtime_probe_task/);
  assert.doesNotMatch(appMain, /runtime_probe_task\(probe\)/);
  assert.ok(source.indexOf("bundle_transport_start(probe)") < source.indexOf("runtime_probe_start_sensors(probe)"));
  assert.ok(source.indexOf("runtime_probe_start_connectivity(probe)") < source.indexOf("runtime_probe_boot(probe)"));
  assert.doesNotMatch(source, /if \(runtime_probe_start_sensors\(probe\)/);
  assert.doesNotMatch(source, /if \(runtime_probe_start_connectivity\(probe\)/);
  assert.doesNotMatch(source, /probe == NULL \|\| probe->sensors == NULL \|\| probe->wifi == NULL/);
  assert.match(source, /if \(probe->sensors == NULL\) \{/);
  assert.match(source, /static void log_sensor_checkpoint\(runtime_probe_t \*probe, bool available\)/);
  assert.match(source, /log_sensor_checkpoint\(probe, available\);/);
});

test("UART acceptance keeps optional touch and motion capability checks fail-soft", () => {
  assert.match(checker, /const optionalCapabilities = new Map\(\[/);
  const required = checker.match(/const required = \[[\s\S]*?\n\];/);
  assert.ok(required, "checker must declare its required checkpoints");
  assert.doesNotMatch(required[0], /"touch_init"/);
  assert.match(checker, /\[\"imu_init\", new Set\(\[\"pass\", \"unavailable\"\]\)\]/);
  assert.match(checker, /\[\"sensor_read\", new Set\(\[\"pass\", \"unavailable\"\]\)\]/);
  assert.match(checker, /\"display_init\"/);
  assert.match(checker, /\[\"touch_init\", new Set\(\[\"pass\", \"unavailable\"\]\)\]/);
  assert.match(checker, /\"bundle_transport_start\"/);
  assert.match(transport, /#define BUNDLE_TRANSPORT_STACK_WORDS \(8192U\)/);
  assert.match(transport, /xTaskCreate\(bundle_transport_task, \"bundle_transport\", BUNDLE_TRANSPORT_STACK_WORDS/);
});

test("transport teardown joins the USB task before runtime probe ownership is released", () => {
  assert.match(transportHeader, /void bundle_transport_stop\(void\);/);
  assert.match(transport, /static SemaphoreHandle_t s_stopped;/);
  assert.match(transport, /xSemaphoreTake\(s_stopped, portMAX_DELAY\)/);
  assert.match(source, /s_active_probe = NULL;[\s\S]*bundle_transport_stop\(\);/);
});

test("lvgl host stages widget creation for reparenting", () => {
  assert.match(lvglHost, /LV_OBJ_FLAG_HIDDEN/);
  assert.match(lvglHost, /staging_parent/);
  assert.match(lvglHost, /lv_label_create\(staging\)/);
  assert.match(lvglHost, /lv_button_create\(staging\)/);
  assert.match(lvglHost, /lv_obj_remove_style_all/);
  assert.match(lvglHost, /case LVGL_HOST_WIDGET_SCREEN:\s*\n\s*object = lv_obj_create\(NULL\);/);
});

test("runtime probe submits the bounded motion period to the QMI cache provider", () => {
  assert.match(source, /JSValue period = JS_GetPropertyStr\(context, argv\[0\], "periodMs"\);/);
  assert.match(source, /probe->board->motion->set_period_ms\(/);
  assert.match(adapterSource, /waveshare_v1_sensors_set_period_ms\(/);
});

test("runtime probe builds each motion event from the snapshot it already read", () => {
  const eventFactory = source.match(/static JSValue new_board_event\([\s\S]*?\n}\n\nstatic JSValue js_native_board_list/);
  assert.ok(eventFactory, "motion event factory must remain present");
  assert.doesNotMatch(eventFactory[0], /waveshare_v1_sensors_read_motion/);
  assert.match(source, /new_board_event\(probe->context, probe, probe->board_handle, probe->board_reload_epoch, &frame, true\)/);
});

test("runtime probe installs Wi-Fi through the existing board owner queue before app boot", () => {
  assert.match(adapterCmake, /waveshare_v1_wifi/);
  assert.match(adapterSource, /waveshare_v1_wifi_submit\(/);
  assert.match(source, /JS_SetPropertyStr\(context, native, "board", board\)/);
  assert.doesNotMatch(source, /JS_SetPropertyStr\(context, native, "wifi"/);
  assert.match(source, /emit_wifi_events\(probe\);/);
  assert.match(source, /"instanceId", JS_NewString\(context, "wifi\.station"\)/);
  assert.match(source, /"correlationId"/);
  assert.ok(source.indexOf("runtime_probe_start_connectivity(probe)") < source.indexOf("runtime_probe_boot(probe)"));
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

test("runtime probe registers setStyle/resetStyle bindings and rejects unknown style prop codes", () => {
  assert.match(source, /JS_SetPropertyStr\(context, lvgl, "setStyle", JS_NewCFunction\(context, js_native_lvgl_set_style, "setStyle", 3\)\)/);
  assert.match(source, /JS_SetPropertyStr\(context, lvgl, "resetStyle",\s*\n\s*JS_NewCFunction\(context, js_native_lvgl_reset_style, "resetStyle", 2\)\)/);
  assert.match(source, /prop < 0 \|\| prop >= LVGL_HOST_STYLE_PROP_COUNT\) return JS_ThrowTypeError\(context, "lvgl\.setStyle: unknown style prop"\)/);
  assert.match(source, /prop < 0 \|\| prop >= LVGL_HOST_STYLE_PROP_COUNT\) return JS_ThrowTypeError\(context, "lvgl\.resetStyle: unknown style prop"\)/);
});

test("C-parity gate: lvgl_host_style_prop_t codes exactly match NATIVE_STYLE_PROP", () => {
  const matches = [...lvglHostHeader.matchAll(/LVGL_HOST_STYLE_(\w+) = (\d+)/g)];
  assert.ok(matches.length > 0, "expected at least one style prop code in lvgl_host.h");
  const fromHeader = {};
  for (const [, name, value] of matches) fromHeader[toCamelCase(name)] = Number(value);
  assert.deepEqual(fromHeader, NATIVE_STYLE_PROP);
});
