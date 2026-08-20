import assert from "node:assert/strict";
import test from "node:test";

import { CliError, DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";
import { parseArgs, runCli } from "../packages/sdk/dist/cli-runtime.js";

const lock = {
  formatVersion: 1,
  package: "@tsx-lvgl/sdk",
  version: "0.1.0",
  sourceSha: "a".repeat(40),
  artifact: { file: ".tsx-lvgl/artifacts/sdk.tgz", sha256: "a".repeat(64), byteLength: 1 },
};

function recorder() {
  const logs = [];
  const errors = [];
  return { logs, errors, writer: { log: (line) => logs.push(line), error: (line) => errors.push(line) } };
}

function operations(overrides = {}) {
  return {
    createProject: async (target, options) => ({ root: `/tmp/${target}`, boardId: options.boardId, lock: { ...lock, artifact: { ...lock.artifact, file: options.artifact ?? lock.artifact.file } } }),
    syncProject: async () => ({ lock }),
    updateProject: async () => ({ lock }),
    checkProject: () => ({ files: ["src/App.tsx"] }),
    buildProject: () => ({ codePath: "build/app.js", manifestPath: "build/app.json", bundle: { manifest: { byteLength: 3, sha256: "digest" } } }),
    devProject: async () => ({ bundleId: "app", generation: 1, texts: ["hello"] }),
    watchDeviceProject: async (_root, options) => options.onAccepted({ bundleId: "app", generation: 1, epoch: 1, retryCount: 0 }),
    doctorProject: () => ({ ok: true, resultCode: "DOCTOR_OK", checks: [] }),
    ...overrides,
  };
}

test("CLI parser normalizes supported options and rejects malformed input", () => {
  assert.deepEqual(parseArgs(["create", "app", "--board", "waveshare.esp32s3.touch-amoled-1.8.v1", "--artifact", "sdk.tgz", "--json", "--"]), { command: "create", positional: ["app"], boardId: "waveshare.esp32s3.touch-amoled-1.8.v1", artifact: "sdk.tgz", json: true });
  assert.equal(parseArgs([]).command, "help");
  assert.deepEqual(parseArgs(["--help"]), { command: "help", positional: [], json: false });
  assert.equal(parseArgs(["sync", "-h"]).command, "help");
  assert.deepEqual(parseArgs(["create", "--artifact", "sdk.tgz", "--source", "framework", "--help"]), { command: "help", positional: [], json: false, artifact: "sdk.tgz", source: "framework" });
  assert.throws(() => parseArgs(["create", "--artifact"]), { code: DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND });
  assert.throws(() => parseArgs(["create", "--board"]), { code: DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND });
  assert.throws(() => parseArgs(["create", "--board", "--json"]), { code: DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND });
  assert.deepEqual(parseArgs(["create", "--board", "waveshare.esp32s3.touch-amoled-1.8.v1", "--help"]), { command: "help", positional: [], json: false, boardId: "waveshare.esp32s3.touch-amoled-1.8.v1" });
  assert.throws(() => parseArgs(["update", "--source", "--json"]), { code: DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND });
  assert.throws(() => parseArgs(["sync", "--wat"]), { code: DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND });
  assert.throws(() => parseArgs(["sync", "--board", "waveshare.esp32s3.touch-amoled-1.8.v1"]), { code: DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND });
  assert.deepEqual(parseArgs(["dev", "--device", "--port", "/dev/cu.fake", "--json"]), { command: "dev", positional: [], device: true, port: "/dev/cu.fake", json: true });
  assert.throws(() => parseArgs(["dev", "--port"]), { code: DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND });
  assert.throws(() => parseArgs(["dev", "--port", "--json"]), { code: DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND });
  assert.deepEqual(
    parseArgs(["dev", "--artifact", "a", "--source", "s", "--device", "--port", "p", "--help"]),
    { command: "help", positional: [], json: false, device: true, artifact: "a", source: "s", port: "p" },
  );
});

test("CLI routes device dev and doctor through existing command names with deterministic JSON", async () => {
  const calls = [];
  const ops = operations({
    watchDeviceProject: async (_root, options) => {
      calls.push(["dev", { device: true, port: options.port }]);
      options.onAccepted({ bundleId: "app", generation: 7, epoch: 3, retryCount: 1 });
    },
    doctorProject: (_root, options) => {
      calls.push(["doctor", options]);
      return { ok: true, resultCode: "DOCTOR_OK", checks: [] };
    },
  });
  let output = recorder();
  assert.equal(await runCli(["dev", "--device", "--port", "/dev/cu.fake", "--json"], "/cwd", ops, output.writer), 0);
  assert.deepEqual(JSON.parse(output.logs[0]), { ok: true, bundleId: "app", generation: 7, epoch: 3, retryCount: 1, code: "DEV_DEVICE_OK" });
  output = recorder();
  assert.equal(await runCli(["doctor", "--device", "--port", "/dev/cu.fake", "--json"], "/cwd", ops, output.writer), 0);
  assert.deepEqual(calls, [["dev", { device: true, port: "/dev/cu.fake" }], ["doctor", { device: true, port: "/dev/cu.fake" }]]);
  output = recorder();
  assert.equal(await runCli(["dev", "--device"], "/cwd", ops, output.writer), 2);
  assert.match(output.errors[0], /requires --port/);
  output = recorder();
  assert.equal(await runCli(["dev", "--port", "/dev/cu.fake"], "/cwd", ops, output.writer), 2);
  assert.match(output.errors[0], /requires dev --device/);
  output = recorder();
  assert.equal(await runCli(["doctor", "--device"], "/cwd", ops, output.writer), 2);
  assert.match(output.errors[0], /requires --port/);
  output = recorder();
  assert.equal(await runCli(["doctor", "--port", "/dev/cu.fake"], "/cwd", ops, output.writer), 2);
  assert.match(output.errors[0], /requires doctor --device/);
  output = recorder();
  const failingOps = operations({
    watchDeviceProject: async () => { throw new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, "serial disconnected"); },
  });
  assert.equal(await runCli(["dev", "--device", "--port", "/dev/cu.fake", "--json"], "/cwd", failingOps, output.writer), 1);
  assert.deepEqual(JSON.parse(output.errors[0]), { ok: false, code: "DEVICE_PUSH_FAILED", message: "serial disconnected" });
  output = recorder();
  const rejectingOps = operations({
    watchDeviceProject: async (_root, options) => options.onRejected("compile failed"),
  });
  assert.equal(await runCli(["dev", "--device", "--port", "/dev/cu.fake"], "/cwd", rejectingOps, output.writer), 0);
  assert.match(output.errors[0], /compile failed/);
});

test("CLI runtime routes every command and preserves machine-readable outcomes", async () => {
  const calls = [];
  const ops = operations({
    createProject: async (...args) => { calls.push(["create", ...args]); return { root: "/tmp/app", boardId: args[1].boardId, lock }; },
    syncProject: async (root) => { calls.push(["sync", root]); return { lock }; },
    updateProject: async (...args) => { calls.push(["update", ...args]); return { lock }; },
    checkProject: (root) => { calls.push(["check", root]); return { files: ["src/App.tsx"] }; },
    buildProject: (root) => { calls.push(["build", root]); return operations().buildProject(); },
    devProject: async (root) => { calls.push(["dev", root]); return operations().devProject(); },
    doctorProject: (root) => { calls.push(["doctor", root]); return { ok: true, resultCode: "DOCTOR_OK", checks: [] }; },
  });
  const createWithoutArtifact = recorder();
  assert.equal(await runCli(["create", "app", "--board", "waveshare.esp32s3.touch-amoled-1.8.v1", "--json"], "/cwd", operations(), createWithoutArtifact.writer), 0);
  assert.equal(JSON.parse(createWithoutArtifact.logs[0]).artifact, lock.artifact.file);
  for (const argv of [["create", "app", "--board", "waveshare.esp32s3.touch-amoled-1.8.v1", "--artifact", "sdk.tgz", "--json"], ["sync"], ["update", "--source", "/framework"], ["check"], ["build"], ["dev", "--json"], ["doctor", "--json"]]) {
    const output = recorder();
    assert.equal(await runCli(argv, "/cwd", ops, output.writer), 0);
    assert.equal(output.errors.length, 0);
    assert.equal(output.logs.length, 1);
  }
  assert.deepEqual(calls.map(([command]) => command), ["create", "sync", "update", "check", "build", "dev", "doctor"]);
});

test("CLI runtime emits help, doctor failures, usage failures and operation errors", async () => {
  let output = recorder();
  assert.equal(await runCli(["help"], "/cwd", operations(), output.writer), 0);
  assert.match(output.logs[0], /Usage:/);
  output = recorder();
  assert.equal(await runCli(["doctor"], "/cwd", operations({ doctorProject: () => ({ ok: true, resultCode: "DOCTOR_OK", checks: [{ ok: true, id: "SDK", successCode: "SDK_OK", detail: "ready" }] }) }), output.writer), 0);
  assert.match(output.logs[0], /PASS SDK SDK_OK: ready/);
  output = recorder();
  assert.equal(await runCli(["doctor"], "/cwd", operations({ doctorProject: () => ({ ok: false, resultCode: "DOCTOR_FAILED", checks: [{ ok: false, id: "SDK", diagnosticCode: "SDK_BAD", detail: "bad" }] }) }), output.writer), 1);
  assert.match(output.logs[0], /FAIL SDK SDK_BAD: bad/);
  output = recorder();
  assert.equal(await runCli(["create", "--artifact"], "/cwd", operations(), output.writer), 2);
  assert.match(output.errors[0], /requires a value/);
  output = recorder();
  assert.equal(await runCli(["create", "--artifact", "--json"], "/cwd", operations(), output.writer), 2);
  assert.equal(JSON.parse(output.errors[0]).code, DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND);
  output = recorder();
  assert.equal(await runCli(["create", "--json"], "/cwd", operations(), output.writer), 2);
  assert.equal(JSON.parse(output.errors[0]).code, DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND);
  output = recorder();
  assert.equal(await runCli(["create", "app", "--json"], "/cwd", operations(), output.writer), 1);
  assert.equal(JSON.parse(output.errors[0]).code, DIAGNOSTIC_CODES.BOARD_SELECTION_REQUIRED);
  output = recorder();
  assert.equal(await runCli(["create", "app", "--board", "waveshare.esp32s3.touch-amoled-1.8", "--json"], "/cwd", operations(), output.writer), 1);
  assert.equal(JSON.parse(output.errors[0]).code, DIAGNOSTIC_CODES.BOARD_TARGET_UNSUPPORTED);
  output = recorder();
  assert.equal(await runCli(["unknown"], "/cwd", operations(), output.writer), 2);
  assert.match(output.errors[1], /Usage:/);
  output = recorder();
  assert.equal(await runCli(["sync"], "/cwd", operations({ syncProject: async () => { throw new CliError(DIAGNOSTIC_CODES.CHECK_FAILED, "nope"); } }), output.writer), 1);
  assert.match(output.errors[0], /CHECK_FAILED/);
  assert.match(output.errors[1], /Usage:/);
  output = recorder();
  assert.equal(await runCli(["sync"], "/cwd", operations({ syncProject: async () => { throw new Error("unexpected"); } }), output.writer), 1);
  assert.match(output.errors[0], /unexpected/);
  output = recorder();
  assert.equal(await runCli(["sync"], "/cwd", operations({ syncProject: async () => { throw "primitive"; } }), output.writer), 1);
  assert.match(output.errors[0], /primitive/);
});
