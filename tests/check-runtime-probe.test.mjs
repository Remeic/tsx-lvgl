import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = resolve(repoRoot, "tools/check-runtime-probe.mjs");
const target = "waveshare.esp32s3.touch-amoled-1.8.v1";
const identityEvidenceCodes = [
  "v1-ft-ack",
  "v2-cst-ack",
  "ambiguous-dual-ack",
  "no-unique-ack",
  "probe-error",
];

const runtimeCheckpoints = [
  "board_start",
  "display_init",
  "engine_cycles",
  "js_eval",
  "lvgl_binding",
  "bundle_transport_start",
  "timer_callback",
  "kernel_start",
  "app_mount",
  "touch_init",
  "imu_init",
  "sensor_read",
];

function validLog(identity = `status=pass target=${target} evidence=v1-ft-ack`) {
  return [
    `PROBE checkpoint=board_identity ${identity}`,
    ...runtimeCheckpoints.map((checkpoint) =>
      `PROBE checkpoint=${checkpoint} status=${checkpoint === "touch_init" || checkpoint === "imu_init" ? "unavailable" : "pass"}`),
  ].join("\n");
}

async function runChecker(log, extraArgs = []) {
  const directory = await mkdtemp(resolve(tmpdir(), "tsx-runtime-checker-"));
  const logPath = resolve(directory, "capture.log");
  try {
    await writeFile(logPath, log);
    return spawnSync(process.execPath, [checker, logPath, ...extraArgs], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("runtime checker accepts a canonical matched identity with bounded evidence", async () => {
  const result = await runChecker(validLog(), ["--target", target]);
  assert.equal(result.status, 0, result.stderr);
});

test("runtime checker enforces the exact status/evidence matrix", async () => {
  const expected = new Map([
    ["pass", new Set(["v1-ft-ack"])],
    ["mismatch", new Set(["v2-cst-ack"])],
    ["unknown", new Set(["ambiguous-dual-ack", "no-unique-ack", "probe-error"])],
  ]);
  for (const [status, allowed] of expected) {
    for (const evidence of identityEvidenceCodes) {
      const result = await runChecker(
        validLog(`status=${status} target=${target} evidence=${evidence}`),
        ["--target", target],
      );
      const shouldPass = status === "pass" && allowed.has(evidence);
      assert.equal(
        result.status === 0,
        shouldPass,
        `${status}/${evidence} should${shouldPass ? "" : " not"} pass: ${result.stderr}`,
      );
    }
  }
});

test("runtime checker rejects identity events missing target or evidence", async () => {
  const missingTarget = await runChecker(validLog("status=pass evidence=v1-ft-ack"));
  assert.notEqual(missingTarget.status, 0);

  const missingEvidence = await runChecker(validLog(`status=pass target=${target}`));
  assert.notEqual(missingEvidence.status, 0);
});

test("runtime checker retains unknown and mismatch failures before a later pass", async () => {
  for (const status of ["unknown", "mismatch"]) {
    const result = await runChecker([
      `PROBE checkpoint=board_identity status=${status} target=${target} evidence=${status === "unknown" ? "probe-error" : "v2-cst-ack"}`,
      validLog(),
    ].join("\n"), ["--target", target]);
    assert.notEqual(result.status, 0, `${status} identity must remain a failure`);
  }
});

test("runtime checker rejects wrong target and invalid evidence", async () => {
  const wrongTarget = await runChecker(validLog(), ["--target", "other.esp32s3.v1"]);
  assert.notEqual(wrongTarget.status, 0);

  const invalidEvidence = await runChecker(validLog(`status=pass target=${target} evidence=raw-i2c-dump`));
  assert.notEqual(invalidEvidence.status, 0);
});
