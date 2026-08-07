import { strict as assert } from "node:assert";
import { jsx } from "@tsx-lvgl/core/jsx-runtime";
import type { VNode } from "@tsx-lvgl/core";
import * as sdk from "@tsx-lvgl/sdk";
import {
  motionSchema,
  type MotionSample,
  type Sensor,
  type SensorContext,
  type SensorSample,
} from "@tsx-lvgl/sensors";
import { test } from "node:test";

import { createHarness, sensorCapabilities } from "./support/harness.js";

test("SDK facade exposes only the supported application surface", () => {
  assert.deepEqual(Object.keys(sdk).sort(), [
    "Button",
    "Fragment",
    "Screen",
    "Text",
    "View",
    "isShake",
    "useEffect",
    "useInterval",
    "useMotion",
    "useState",
  ]);
});

test("useMotion reads the motion schema through the runtime hook", async () => {
  const sensor: Sensor<MotionSample> = {
    schema: motionSchema,
    read(context: SensorContext): Promise<SensorSample<MotionSample>> {
      return Promise.resolve({
        sensorId: motionSchema.id,
        schemaVersion: motionSchema.version,
        sequence: 1,
        sampledAtMs: 10,
        reloadEpoch: context.reloadEpoch,
        status: "ok",
        value: {
          accelerationMps2: [0, 0, 0],
          angularVelocityDps: [0, 0, 0],
        },
      });
    },
    subscribe(): () => void {
      return () => undefined;
    },
  };
  const { host, scheduler, runtime } = createHarness({ capabilities: sensorCapabilities(sensor) });

  function App(): VNode {
    const sample = sdk.useMotion();
    return jsx(sdk.Screen, { children: jsx(sdk.Text, { text: sample?.status ?? "waiting" }) });
  }

  runtime.mount(jsx(App, {}));
  await Promise.resolve();
  await Promise.resolve();
  scheduler.flush();
  assert.equal(host.text(), "ok");
  runtime.unmount();
});
