import assert from "node:assert/strict";
import test from "node:test";

import { runDevicePush } from "../packages/sdk/dist/device-dev.js";
import { DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";
import { validateSerialPort } from "../packages/sdk/dist/serial.js";

const bundle = {
  manifest: {
    bundleId: "app",
    format: "js",
    engine: "quickjs-ng",
    protocolVersion: 1,
    boardId: "waveshare.esp32s3.touch-amoled-1.8",
    generation: 5,
    sha256: "a".repeat(64),
    byteLength: 3,
  },
  bytes: new Uint8Array([1, 2, 3]),
};

function fakeRuntime() {
  const writes = [];
  const lineListeners = new Set();
  const errorListeners = new Set();
  const timers = [];
  let closed = false;
  let writeFailure;
  let writeFailureMode = "reject";
  let closeFailure;
  let closeFailureMode = "reject";
  let closeCalls = 0;
  const channel = {
    write: (line) => {
      writes.push(line);
      if (writeFailure !== undefined) {
        if (writeFailureMode === "throw") throw writeFailure;
        return Promise.reject(writeFailure);
      }
      return Promise.resolve();
    },
    onLine: (listener) => {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    close: () => {
      closeCalls += 1;
      closed = true;
      if (closeFailure !== undefined) {
        if (closeFailureMode === "throw") throw closeFailure;
        return Promise.reject(closeFailure);
      }
      return Promise.resolve();
    },
  };
  return {
    writes,
    timers,
    get closed() { return closed; },
    get closeCalls() { return closeCalls; },
    emit: (line) => { for (const listener of lineListeners) listener(line); },
    emitError: (error) => { for (const listener of errorListeners) listener(error); },
    failWritesWith: (error, mode = "reject") => { writeFailure = error; writeFailureMode = mode; },
    failCloseWith: (error, mode = "reject") => { closeFailure = error; closeFailureMode = mode; },
    fireTimer: () => timers.findLast((timer) => !timer.cancelled)?.callback(),
    runtime: {
      serial: { open: () => channel },
      setTimer: (callback, delayMs) => {
        const timer = { callback, delayMs, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => { timer.cancelled = true; },
    },
  };
}

function rdy(lastGeneration) {
  return `TSXB RDY maxBytes=262144 protocol=1 board=${bundle.manifest.boardId} lastGeneration=${lastGeneration}`;
}

const settleTasks = () => new Promise((resolve) => setImmediate(resolve));

test("device push runs the pure TSXB session through an injected serial channel", async () => {
  const fake = fakeRuntime();
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
  await settleTasks();
  assert.match(fake.writes[0], /^TSXB BEGIN /);
  fake.emit(rdy(4));
  await settleTasks();
  assert.match(fake.writes[1], /^TSXB DATA 1 /);
  fake.emit("TSXB ACK 1");
  await settleTasks();
  assert.equal(fake.writes[2], "TSXB END 1");
  fake.emit("TSXB OK bundle=app generation=5 epoch=9");
  assert.deepEqual(await pending, { bundleId: "app", generation: 5, epoch: 9, retryCount: 0 });
  assert.equal(fake.closed, true);
});

test("device push retries once with a generation negotiated from RDY and never persists it", async () => {
  const fake = fakeRuntime();
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
  await settleTasks();
  fake.emit(rdy(5));
  await settleTasks();
  assert.equal(fake.writes[1], "TSXB ABORT");
  assert.match(fake.writes[2], /^TSXB BEGIN /);
  const retriedManifest = JSON.parse(Buffer.from(fake.writes[2].slice("TSXB BEGIN ".length), "base64").toString("utf8"));
  assert.equal(retriedManifest.generation, 6);
  assert.equal(bundle.manifest.generation, 5);
  fake.emit(rdy(5));
  fake.emit("TSXB ACK 1");
  fake.emit("TSXB OK bundle=app generation=6 epoch=10");
  assert.deepEqual(await pending, { bundleId: "app", generation: 6, epoch: 10, retryCount: 1 });
});

test("device push refuses a second stale generation rather than retrying indefinitely", async () => {
  const fake = fakeRuntime();
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
  await settleTasks();
  fake.emit(rdy(5));
  await settleTasks();
  fake.emit(rdy(6));
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "generation not monotonic" });
  assert.equal(fake.writes.filter((line) => line === "TSXB ABORT").length, 2);
  assert.equal(fake.closed, true);
});

test("device push fails deterministically on timeout and cleans up the injected channel", async () => {
  const fake = fakeRuntime();
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
  await settleTasks();
  fake.fireTimer();
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "timeout in awaiting-rdy" });
  assert.equal(fake.writes.at(-1), "TSXB ABORT");
  assert.equal(fake.closed, true);
});

test("noise never extends the bounded ACK timeout even under an infinite-log-shaped burst", async () => {
  const fake = fakeRuntime();
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
  await settleTasks();
  const firstTimer = fake.timers[0];
  for (let index = 0; index < 1000; index += 1) fake.emit(`I (${index}) device log`);
  await settleTasks();
  assert.equal(fake.timers.length, 1);
  assert.equal(firstTimer.cancelled, false);
  fake.fireTimer();
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "timeout in awaiting-rdy" });
  assert.equal(fake.writes.at(-1), "TSXB ABORT");
  assert.equal(fake.closed, true);
});

test("duplicate RDY after the handshake is ignored without retrying or duplicating payload", async () => {
  const fake = fakeRuntime();
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
  await settleTasks();
  fake.emit(rdy(4));
  await settleTasks();
  assert.equal(fake.writes.filter((line) => line.startsWith("TSXB DATA")).length, 1);
  const timerCount = fake.timers.length;
  fake.emit(rdy(5));
  await settleTasks();
  assert.equal(fake.timers.length, timerCount);
  assert.equal(fake.writes.filter((line) => line === "TSXB ABORT").length, 0);
  assert.equal(fake.writes.filter((line) => line.startsWith("TSXB BEGIN")).length, 1);
  assert.equal(fake.writes.filter((line) => line.startsWith("TSXB DATA")).length, 1);
  fake.emit("TSXB ACK 1");
  await settleTasks();
  fake.emit("TSXB OK bundle=app generation=5 epoch=11");
  assert.deepEqual(await pending, { bundleId: "app", generation: 5, epoch: 11, retryCount: 0 });
});

test("a rejected channel write settles once, attempts abort and closes without unhandled rejection", async () => {
  const fake = fakeRuntime();
  fake.failWritesWith(new Error("write rejected"));
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "write rejected" });
  assert.equal(fake.writes.filter((line) => line === "TSXB ABORT").length, 1);
  assert.equal(fake.closed, true);
  assert.equal(fake.timers.every((timer) => timer.cancelled), true);
});

test("a thrown channel write after RDY settles once and cleans the active timer", async () => {
  const fake = fakeRuntime();
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
  await settleTasks();
  fake.failWritesWith(new Error("write threw"), "throw");
  fake.emit(rdy(4));
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "write threw" });
  assert.equal(fake.closed, true);
  assert.equal(fake.timers.every((timer) => timer.cancelled), true);
});

test("an asynchronous serial error settles once with abort, close and timer cleanup", async () => {
  const fake = fakeRuntime();
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
  await settleTasks();
  fake.emitError(new Error("serial disconnected"));
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "serial disconnected" });
  assert.equal(fake.writes.at(-1), "TSXB ABORT");
  assert.equal(fake.closeCalls, 1);
  assert.equal(fake.timers.every((timer) => timer.cancelled), true);
});

test("a rejected close after device OK becomes one deterministic failure", async () => {
  const fake = fakeRuntime();
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
  await settleTasks();
  fake.emit(rdy(4));
  await settleTasks();
  fake.emit("TSXB ACK 1");
  await settleTasks();
  fake.failCloseWith(new Error("close rejected"));
  fake.emit("TSXB OK bundle=app generation=5 epoch=12");
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "close rejected" });
  assert.equal(fake.closed, true);
  assert.equal(fake.timers.every((timer) => timer.cancelled), true);
});

test("a thrown close during failure preserves the primary error and does not hang", async () => {
  const fake = fakeRuntime();
  fake.failCloseWith(new Error("close threw"), "throw");
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
  await settleTasks();
  fake.fireTimer();
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "timeout in awaiting-rdy" });
  assert.equal(fake.closed, true);
  assert.equal(fake.closeCalls, 1);
  assert.equal(fake.timers.every((timer) => timer.cancelled), true);
});

test("device push validates shared timeout overrides before opening a serial port", async () => {
  const fake = fakeRuntime();
  await assert.rejects(
    runDevicePush(bundle, "/dev/cu.fake", fake.runtime, { ackTimeoutMs: 0 }),
    { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "ackTimeoutMs must be a positive number" },
  );
  assert.equal(fake.writes.length, 0);
});

test("serial port validation is machine-local and never accepts shell-shaped input", () => {
  assert.equal(validateSerialPort("/dev/cu.usbmodem123"), "/dev/cu.usbmodem123");
  assert.equal(validateSerialPort("COM3"), "COM3");
  for (const candidate of ["", "relative", "/tmp/serial", "/dev/cu.ok;rm -rf /", "--port"]) {
    assert.throws(() => validateSerialPort(candidate), { code: DIAGNOSTIC_CODES.DEVICE_PORT_INVALID });
  }
});
