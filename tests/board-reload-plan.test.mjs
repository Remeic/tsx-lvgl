import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  APP_FLASH_OFFSET,
  buildReloadPlan,
} from "../scripts/board-reload-plan.mjs";

const config = {
  esptoolPython: "/opt/tsx-lvgl-esptool/bin/python",
  port: "/dev/cu.usbmodem101",
  artifact: "/workspace/build/tsx_lvgl_esp32_s3_v1.bin",
  baud: 115200,
  resetMode: "watchdog-reset",
};

test("reload plan keeps the physical mutation app-only", () => {
  const plan = buildReloadPlan(config);
  const commands = plan.steps.map((step) => step.command.join(" "));

  assert.deepEqual(plan.steps.map((step) => step.name), [
    "chip-id",
    "flash-id",
    "read-mac",
    "security-info",
    "efuse-summary",
    "efuse-dump",
    "write-flash",
    "verify-flash",
    "reset",
  ]);

  const write = plan.steps.find((step) => step.name === "write-flash");
  assert.equal(write.mutation, "app-only");
  assert.deepEqual(write.command.slice(-8), [
    "--flash-mode",
    "keep",
    "--flash-freq",
    "keep",
    "--flash-size",
    "keep",
    APP_FLASH_OFFSET,
    config.artifact,
  ]);

  const verify = plan.steps.find((step) => step.name === "verify-flash");
  assert.deepEqual(verify.command.slice(-2), [APP_FLASH_OFFSET, config.artifact]);

  const reset = plan.steps.find((step) => step.name === "reset");
  assert.ok(reset.command.includes("watchdog-reset"));

  for (const command of commands) {
    assert.doesNotMatch(command, /erase-flash|erase-region|burn-|write-protect|read-protect/);
  }
});

test("reload plan rejects unsafe ports, reset modes, and missing artifact paths", () => {
  assert.throws(
    () => buildReloadPlan({ ...config, port: "/Volumes/T7 Shield/image.bin" }),
    /serial port/,
  );
  assert.throws(
    () => buildReloadPlan({ ...config, resetMode: "erase-flash" }),
    /reset mode/,
  );
  assert.throws(
    () => buildReloadPlan({ ...config, artifact: "" }),
    /artifact/,
  );
});

test("firmware exposes a visible hot-reload diagnostic", async () => {
  const source = await readFile(
    new URL("../examples/esp-idf/tsx_lvgl_v1/main/app_main.c", import.meta.url),
    "utf8",
  );

  assert.match(source, /HOT RELOAD TEST/);
  assert.match(source, /RTC_DATA_ATTR/);
  assert.match(source, /esp_reset_reason\(\)/);
  assert.match(source, /lv_label_set_text/);
  assert.match(source, /boot %/);
});
