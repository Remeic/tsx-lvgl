#!/usr/bin/env node

import { readFile } from "node:fs/promises";

function usage() {
  return `Usage:
  node tools/check-runtime-probe.mjs <uart-log> [--require-reload]

Options:
  --require-reload   Also require bundle_reload and bundle_reject checkpoints
                      (evidence a TSXB hot reload and a rejection were both
                      exercised over the log's capture window).
`;
}

const args = process.argv.slice(2);
const logPath = args.find((arg) => !arg.startsWith("--"));
const requireReload = args.includes("--require-reload");
if (!logPath) {
  console.error(usage());
  process.exit(2);
}

const log = await readFile(logPath, "utf8");
const required = [
  "board_start",
  "display_init",
  "touch_init",
  "engine_cycles",
  "js_eval",
  "lvgl_binding",
  "bundle_transport_start",
  "timer_callback",
  "kernel_start",
  "app_mount",
  ...(requireReload ? ["bundle_reload", "bundle_reject"] : []),
];
const optionalCapabilities = new Map([
  ["touch_init", new Set(["pass", "unavailable"])],
  ["imu_init", new Set(["pass", "unavailable"])],
  ["sensor_read", new Set(["pass", "unavailable"])],
]);
const checkpoints = new Map();
for (const match of log.matchAll(/PROBE checkpoint=(\S+) status=(\S+)/g)) {
  checkpoints.set(match[1], match[2]);
}

const failures = required.filter((checkpoint) => checkpoints.get(checkpoint) !== "pass");
for (const [checkpoint, allowed] of optionalCapabilities) {
  const status = checkpoints.get(checkpoint);
  if (status === undefined || !allowed.has(status)) failures.push(checkpoint);
}
if (failures.length > 0) {
  console.error(`runtime probe incomplete: ${failures.join(", ")}`);
  for (const checkpoint of [...required, ...optionalCapabilities.keys()]) {
    console.error(`  ${checkpoint}: ${checkpoints.get(checkpoint) ?? "missing"}`);
  }
  process.exit(1);
}

console.log(`runtime probe passed: ${[...required, ...optionalCapabilities.keys()].join(", ")}`);
