import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../examples/esp-idf/runtime_port_probe/main/runtime_probe.c", import.meta.url), "utf8");

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
