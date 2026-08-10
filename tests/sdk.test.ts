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
  assert.deepEqual(APPLICATION_FACADE_KEYS, [
    "Button",
    "Fragment",
    "Screen",
    "Text",
    "View",
    "isShake",
    "useEffect",
    "useInterval",
    "useMotion",
    "useWifi",
    "useState",
  ]);
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
