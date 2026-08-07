import { strict as assert } from "node:assert";
import * as sdk from "@tsx-lvgl/sdk";
import { test } from "node:test";

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
