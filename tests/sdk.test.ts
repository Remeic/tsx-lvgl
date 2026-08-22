import { strict as assert } from "node:assert";
import { jsx } from "@tsx-lvgl/core/jsx-runtime";
import type { VNode } from "@tsx-lvgl/core";
import { BoardRuntime, MemoryBoardAdapter, createDefaultBoardDescriptors, encodeBoardPayload } from "@tsx-lvgl/device";
import * as sdk from "@tsx-lvgl/sdk";
import { APPLICATION_FACADE_KEYS } from "@tsx-lvgl/core";
import { test } from "node:test";

import { createHarness } from "./support/harness.js";

test("SDK facade exposes only the supported application surface", () => {
  assert.deepEqual(Object.keys(sdk).sort(), [...APPLICATION_FACADE_KEYS].sort());
});

test("StyleSheet.create freezes the sheet and every entry", () => {
  const sheet = sdk.StyleSheet.create({ box: { backgroundColor: "red" }, text: { color: "blue" } });
  assert.equal(Object.isFrozen(sheet), true);
  assert.equal(Object.isFrozen(sheet.box), true);
  assert.equal(Object.isFrozen(sheet.text), true);
  assert.deepEqual(sheet.box, { backgroundColor: "red" });
});

test("useMotion reads the motion schema through the board capability runtime", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const board = new BoardRuntime(adapter);
  const { host, scheduler, runtime } = createHarness({ board });

  function App(): VNode {
    const motion = sdk.useMotion();
    return jsx(sdk.Screen, { children: jsx(sdk.Text, { text: motion.state.status }) });
  }

  runtime.mount(jsx(App, {}));
  assert.equal(host.text(), "starting");
  adapter.emit({
    version: 1,
    kind: "state",
    handle: 1,
    reloadEpoch: 1,
    sequence: 1,
    observedAtMs: 10,
    payload: encodeBoardPayload({
      status: "ok",
      schemaVersion: 1,
      value: { accelerationMps2: [0, 0, 0], angularVelocityDps: [0, 0, 0] },
    }),
  });
  scheduler.flush();
  assert.equal(host.text(), "ready");
  runtime.unmount();
});

test("useShake applies per-app thresholds and cooldown to motion observations", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const board = new BoardRuntime(adapter);
  const { host, scheduler, runtime } = createHarness({ board });

  function App(): VNode {
    const shake = sdk.useShake({
      accelerationDeltaMps2: 12,
      angularVelocityDps: null,
      cooldownMs: 500,
    });
    return jsx(sdk.Screen, { children: jsx(sdk.Text, { text: shake.count }) });
  }

  runtime.mount(jsx(App, {}));
  const emit = (
    sequence: number,
    observedAtMs: number,
    accelerationMps2: readonly [number, number, number],
    angularVelocityDps: readonly [number, number, number],
  ): void => adapter.emit({
    version: 1,
    kind: "state",
    handle: 1,
    reloadEpoch: 1,
    sequence,
    observedAtMs,
    payload: encodeBoardPayload({
      status: "ok",
      schemaVersion: 1,
      value: { accelerationMps2, angularVelocityDps },
    }),
  });

  emit(1, 10, [0, 0, 9.80665], [260, 0, 0]);
  scheduler.flush();
  assert.equal(host.text(), "0");

  emit(2, 20, [30, 0, 0], [0, 0, 0]);
  scheduler.flush();
  assert.equal(host.text(), "1");

  emit(3, 100, [30, 0, 0], [0, 0, 0]);
  scheduler.flush();
  assert.equal(host.text(), "1");

  emit(4, 520, [30, 0, 0], [0, 0, 0]);
  scheduler.flush();
  assert.equal(host.text(), "2");
  runtime.unmount();
});

test("useShake validates its hook seam and cooldown", () => {
  assert.throws(
    () => sdk.useShake(),
    /useShake must be called while rendering a component/,
  );

  function InvalidCooldown(): VNode {
    sdk.useShake({ cooldownMs: -1 });
    return jsx(sdk.Screen, {});
  }

  const { runtime } = createHarness();
  assert.throws(
    () => runtime.mount(jsx(InvalidCooldown, {})),
    /useShake cooldownMs must be a non-negative finite number/,
  );
});
