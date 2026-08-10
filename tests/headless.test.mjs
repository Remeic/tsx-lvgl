import assert from "node:assert/strict";
import test from "node:test";

import { compileTsxBundle } from "../packages/bundler/dist/index.js";
import { createHeadlessNative, runHeadless } from "../packages/sdk/dist/headless.js";

test("headless SDK host renders a portable application bundle", async () => {
  const bundle = compileTsxBundle({
    fileName: "App.tsx",
    source: 'import { Screen, Text } from "@tsx-lvgl/sdk"; export default function App() { return <Screen><Text text="headless" /></Screen>; }',
    bundleId: "headless",
    boardId: "waveshare.esp32s3.touch-amoled-1.8",
    generation: 1,
    jsxImportSource: "@tsx-lvgl/sdk",
  });
  assert.deepEqual(
    await runHeadless({ manifest: bundle.manifest, source: bundle.bytes }, "waveshare.esp32s3.touch-amoled-1.8"),
    { texts: ["headless"], logs: [], generation: 1 },
  );
});

test("headless native exercises lifecycle, hierarchy, sensors, timers and edge cases", () => {
  const host = createHeadlessNative("board");
  const screen = host.native.lvgl.create("screen");
  const first = host.native.lvgl.create("text");
  const second = host.native.lvgl.create("text");
  host.native.lvgl.setText(first, "first");
  host.native.lvgl.setText(second, "second");
  host.native.lvgl.insert(screen, first, 99);
  host.native.lvgl.insert(screen, second, -1);
  host.native.lvgl.insert(screen, first, 0);
  host.native.lvgl.remove(screen, 999);
  host.native.lvgl.loadScreen(screen);
  assert.deepEqual(host.activeTexts(), ["first", "second"]);
  assert.throws(() => host.native.lvgl.setText(999, "missing"), /unknown node 999/);
  host.native.lvgl.setClickable(first, true);
  const timer = host.native.timers.setInterval(() => undefined, 10);
  host.native.timers.clearInterval(timer);
  assert.deepEqual(host.native.sensors.read("other"), { status: "unavailable", sampledAtMs: 0 });
  assert.equal(host.native.sensors.read("board.qmi8658.motion").status, "ok");
  host.native.onClick(() => undefined);
  host.native.log("log");
  assert.deepEqual(host.logs, ["log"]);
  host.native.lvgl.dispose(999);
  host.native.lvgl.dispose(screen);
  assert.deepEqual(host.activeTexts(), []);
});
