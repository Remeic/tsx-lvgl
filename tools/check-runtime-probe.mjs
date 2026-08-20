#!/usr/bin/env node

import { readFile } from "node:fs/promises";

function usage() {
  return `Usage:
  node tools/check-runtime-probe.mjs <uart-log> [--target <board-id>] [--require-reload]

Options:
  --target <board-id> Require the matched identity checkpoint to name this target.
  --require-reload   Also require bundle_reload and bundle_reject checkpoints
                      (evidence a TSXB hot reload and a rejection were both
                      exercised over the log's capture window).
`;
}

const args = process.argv.slice(2);
const requireReload = args.includes("--require-reload");
const positional = [];
let target;
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === "--require-reload") continue;
  if (argument === "--target") {
    target = args[++index];
    if (target === undefined || target.startsWith("--")) {
      console.error(usage());
      process.exit(2);
    }
    continue;
  }
  if (argument.startsWith("--")) {
    console.error(usage());
    process.exit(2);
  }
  positional.push(argument);
}
const logPath = positional[0];
if (!logPath) {
  console.error(usage());
  process.exit(2);
}

const CANONICAL_TARGET_MAX_LENGTH = 64;
const CANONICAL_TARGET_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const IDENTITY_EVIDENCE_BY_STATUS = new Map([
  ["pass", new Set(["v1-ft-ack"])],
  ["mismatch", new Set(["v2-cst-ack"])],
  ["unknown", new Set(["ambiguous-dual-ack", "no-unique-ack", "probe-error"])],
]);
const IDENTITY_EVIDENCE_CODES = new Set(
  [...IDENTITY_EVIDENCE_BY_STATUS.values()].flatMap((codes) => [...codes]),
);

function isCanonicalTarget(value) {
  return value !== undefined && value.length > 0 && value.length <= CANONICAL_TARGET_MAX_LENGTH &&
    CANONICAL_TARGET_PATTERN.test(value);
}

const log = await readFile(logPath, "utf8");
const required = [
  "board_identity",
  "board_start",
  "display_init",
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
const events = [];
for (const match of log.matchAll(/PROBE checkpoint=(\S+) status=(\S+)([^\r\n]*)/g)) {
  const checkpoint = match[1];
  const status = match[2];
  const attributes = new Map();
  for (const attribute of match[3].matchAll(/(?:^|\s)([a-z][a-z0-9_-]*)=(\S+)/g)) {
    attributes.set(attribute[1], attribute[2]);
  }
  const observedTarget = attributes.get("target");
  const evidenceCode = attributes.get("evidence");
  checkpoints.set(checkpoint, status);
  events.push({ checkpoint, status, observedTarget, evidenceCode });
}

const failures = required.filter((checkpoint) => checkpoints.get(checkpoint) !== "pass");
for (const [checkpoint, allowed] of optionalCapabilities) {
  const status = checkpoints.get(checkpoint);
  if (status === undefined || !allowed.has(status)) failures.push(checkpoint);
}

/* Every runtime checkpoint must be preceded by a positive identity result.
 * This keeps a later `pass` from hiding an earlier rejected boot in a mixed
 * UART capture and makes the gate useful even when a checkpoint is duplicated. */
let latestIdentityStatus;
const identityOrderFailures = new Set();
for (const { checkpoint, status, observedTarget, evidenceCode } of events) {
  if (checkpoint === "board_identity") {
    if (!isCanonicalTarget(observedTarget)) {
      identityOrderFailures.add(`board_identity (target=${observedTarget ?? "missing"})`);
    }
    const allowedEvidence = IDENTITY_EVIDENCE_BY_STATUS.get(status);
    if (!allowedEvidence?.has(evidenceCode) || !IDENTITY_EVIDENCE_CODES.has(evidenceCode)) {
      identityOrderFailures.add(`board_identity (status=${status} evidence=${evidenceCode ?? "missing"})`);
    }
    if (target !== undefined && observedTarget !== target) {
      identityOrderFailures.add(`board_identity (target=${observedTarget ?? "missing"})`);
    }
    if (status !== "pass") {
      /* A later positive event cannot erase an earlier rejected observation in
       * a mixed capture. The operator must split the capture or investigate
       * the failed boot before acceptance. */
      identityOrderFailures.add(`board_identity (status=${status})`);
    }
    latestIdentityStatus = status;
    continue;
  }
  if (required.includes(checkpoint) || optionalCapabilities.has(checkpoint)) {
    if (latestIdentityStatus !== "pass") {
      identityOrderFailures.add(`${checkpoint} (identity=${latestIdentityStatus ?? "missing"})`);
    }
  }
}
if (target !== undefined && !isCanonicalTarget(target)) {
  identityOrderFailures.add(`requested target (invalid=${target})`);
}
failures.push(...identityOrderFailures);
if (failures.length > 0) {
  console.error(`runtime probe incomplete: ${failures.join(", ")}`);
  for (const checkpoint of [...required, ...optionalCapabilities.keys()]) {
    console.error(`  ${checkpoint}: ${checkpoints.get(checkpoint) ?? "missing"}`);
  }
  for (const failure of identityOrderFailures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`runtime probe passed: ${[...required, ...optionalCapabilities.keys()].join(", ")}`);
