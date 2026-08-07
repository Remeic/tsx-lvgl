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
  "engine_cycles",
  "js_eval",
  "lvgl_binding",
  "imu_init",
  "sensor_read",
  "timer_callback",
  "kernel_start",
  "app_mount",
  ...(requireReload ? ["bundle_reload", "bundle_reject"] : []),
];
const checkpoints = new Map();
for (const match of log.matchAll(/PROBE checkpoint=(\S+) status=(\S+)/g)) {
  checkpoints.set(match[1], match[2]);
}

const failures = required.filter((checkpoint) => checkpoints.get(checkpoint) !== "pass");
if (failures.length > 0) {
  console.error(`runtime probe incomplete: ${failures.join(", ")}`);
  for (const checkpoint of required) {
    console.error(`  ${checkpoint}: ${checkpoints.get(checkpoint) ?? "missing"}`);
  }
  process.exit(1);
}

console.log(`runtime probe passed: ${required.join(", ")}`);
