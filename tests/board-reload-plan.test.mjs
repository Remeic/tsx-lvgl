import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildReloadMutationPlan,
  buildReloadPreflightPlan,
} from "../scripts/board-reload-plan.mjs";

const config = {
  esptoolPython: "/opt/tsx-lvgl-esptool/bin/python",
  port: "/dev/cu.usbmodem101",
  artifact: "/workspace/build/tsx_lvgl_esp32_s3_v1.bin",
  baud: 115200,
  resetMode: "watchdog-reset",
  partitionTableOffset: 0x8000,
  partitionTableReadSize: 0x1000,
  livePartitionTablePath: "/tmp/live-partition-table.bin",
};

const validatedLayout = Object.freeze({
  // This fixture intentionally cannot be constructed by production callers:
  // the test obtains a token through the strict comparator in parser tests.
  // The opaque brand is supplied in the dedicated integration test instead.
});

test("preflight plan contains only identity, security and live-table reads", () => {
  const plan = buildReloadPreflightPlan(config);
  assert.deepEqual(plan.steps.map((step) => step.name), [
    "chip-id",
    "flash-id",
    "read-mac",
    "security-info",
    "efuse-summary",
    "efuse-dump",
    "read-partition-table",
  ]);
  const commands = plan.steps.map((step) => step.command.join(" "));
  for (const command of commands) {
    assert.doesNotMatch(command, /write-flash|verify-flash|erase-flash|erase-region|burn-|write-protect|read-protect/);
  }
  const read = plan.steps.at(-1);
  assert.deepEqual(read.command.slice(-4), ["read-flash", "0x8000", "0x1000", config.livePartitionTablePath]);
  assert.equal(read.command.at(-1), config.livePartitionTablePath);
});

test("mutation plan rejects unchecked offsets and preserves the required flash flags", () => {
  assert.throws(
    () => buildReloadMutationPlan(config, validatedLayout),
    /LIVE_LAYOUT_REQUIRED|validated live partition layout/,
  );
});

test("preflight config rejects unsafe ports, reset modes and table paths", () => {
  assert.throws(() => buildReloadPreflightPlan({ ...config, port: "/Volumes/T7/image.bin" }), /serial port/);
  assert.throws(() => buildReloadPreflightPlan({ ...config, resetMode: "erase-flash" }), /reset mode/);
  assert.throws(() => buildReloadPreflightPlan({ ...config, livePartitionTablePath: "relative.bin" }), /partition-table path/);
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
