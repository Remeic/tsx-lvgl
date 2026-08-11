import assert from "node:assert/strict";
import test from "node:test";

import { runDevicePush } from "../packages/sdk/dist/device-dev.js";
import { DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";
import { closeSerialResources, validateSerialPort } from "../packages/sdk/dist/serial.js";

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
  let hungWrite;
  let rejectHungWrite;
  let closeHangs = false;
  let rejectHungClose;
  let closeCalls = 0;
  const channel = {
    write: (line) => {
      writes.push(line);
      if (writeFailure !== undefined) {
        if (writeFailureMode === "throw") throw writeFailure;
        return Promise.reject(writeFailure);
      }
      if (hungWrite?.(line)) return new Promise((_resolve, reject) => { rejectHungWrite = reject; });
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
      if (closeHangs) return new Promise((_resolve, reject) => { rejectHungClose = reject; });
      return Promise.resolve();
    },
  };
  return {
    writes,
    timers,
    get closed() { return closed; },
    get closeCalls() { return closeCalls; },
    get lineListenerCount() { return lineListeners.size; },
    get errorListenerCount() { return errorListeners.size; },
    emit: (line) => { for (const listener of lineListeners) listener(line); },
    emitError: (error) => { for (const listener of errorListeners) listener(error); },
    failWritesWith: (error, mode = "reject") => { writeFailure = error; writeFailureMode = mode; },
    hangWritesMatching: (predicate) => { hungWrite = predicate; },
    rejectHungWrite: (error) => rejectHungWrite?.(error),
    failCloseWith: (error, mode = "reject") => { closeFailure = error; closeFailureMode = mode; },
    hangClose: () => { closeHangs = true; },
    rejectHungClose: (error) => rejectHungClose?.(error),
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

function rdy(lastGeneration, overrides = {}) {
  return `TSXB RDY maxBytes=${overrides.maxBytes ?? 262144} protocol=${overrides.protocol ?? 1} board=${overrides.board ?? bundle.manifest.boardId} lastGeneration=${lastGeneration}`;
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
  const activeTimers = fake.timers.filter((timer) => !timer.cancelled);
  assert.equal(activeTimers.length, 1);
  const firstTimer = activeTimers[0];
  const timerCount = fake.timers.length;
  for (let index = 0; index < 1000; index += 1) fake.emit(`I (${index}) device log`);
  await settleTasks();
  assert.equal(fake.timers.length, timerCount);
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

test("a hung BEGIN write reaches an independent I/O deadline and settles with cleanup", async () => {
  const fake = fakeRuntime();
  fake.hangWritesMatching((line) => line.startsWith("TSXB BEGIN"));
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime, { ackTimeoutMs: 10 });
  await settleTasks();
  fake.fireTimer();
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "serial write timed out" });
  fake.rejectHungWrite(new Error("late write rejection"));
  await settleTasks();
  assert.equal(fake.writes.at(-1), "TSXB ABORT");
  assert.equal(fake.closeCalls, 1);
  assert.equal(fake.lineListenerCount, 0);
  assert.equal(fake.errorListenerCount, 0);
  assert.equal(fake.timers.every((timer) => timer.cancelled), true);
});

test("a serial error bypasses a hung DATA write and settles exactly once", async () => {
  const fake = fakeRuntime();
  fake.hangWritesMatching((line) => line.startsWith("TSXB DATA"));
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime, { ackTimeoutMs: 10 });
  await settleTasks();
  fake.emit(rdy(4));
  await settleTasks();
  fake.emitError(new Error("serial disconnected during data"));
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "serial disconnected during data" });
  assert.equal(fake.writes.at(-1), "TSXB ABORT");
  assert.equal(fake.closeCalls, 1);
  assert.equal(fake.lineListenerCount, 0);
  assert.equal(fake.errorListenerCount, 0);
  assert.equal(fake.timers.every((timer) => timer.cancelled), true);
});

test("a hung ABORT cannot mask the primary timeout or prevent close", async () => {
  const fake = fakeRuntime();
  fake.hangWritesMatching((line) => line === "TSXB ABORT");
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime, { ackTimeoutMs: 10 });
  await settleTasks();
  fake.fireTimer();
  await settleTasks();
  fake.fireTimer();
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "timeout in awaiting-rdy" });
  assert.equal(fake.closeCalls, 1);
  assert.equal(fake.lineListenerCount, 0);
  assert.equal(fake.errorListenerCount, 0);
  assert.equal(fake.timers.every((timer) => timer.cancelled), true);
});

test("a hung close after OK settles as a deterministic failure", async () => {
  const fake = fakeRuntime();
  fake.hangClose();
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime, { ackTimeoutMs: 10 });
  await settleTasks();
  fake.emit(rdy(4));
  await settleTasks();
  fake.emit("TSXB ACK 1");
  await settleTasks();
  fake.emit("TSXB OK bundle=app generation=5 epoch=12");
  await settleTasks();
  fake.fireTimer();
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "serial close timed out" });
  fake.rejectHungClose(new Error("late close rejection"));
  await settleTasks();
  assert.equal(fake.closeCalls, 1);
  assert.equal(fake.lineListenerCount, 0);
  assert.equal(fake.errorListenerCount, 0);
  assert.equal(fake.timers.every((timer) => timer.cancelled), true);
});

test("a hung close during failure cannot replace the primary protocol error", async () => {
  const fake = fakeRuntime();
  fake.hangClose();
  const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime, { ackTimeoutMs: 10 });
  await settleTasks();
  fake.fireTimer();
  await settleTasks();
  fake.fireTimer();
  await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: "timeout in awaiting-rdy" });
  assert.equal(fake.closeCalls, 1);
  assert.equal(fake.lineListenerCount, 0);
  assert.equal(fake.errorListenerCount, 0);
  assert.equal(fake.timers.every((timer) => timer.cancelled), true);
});

test("invalid stale RDY identity fails before generation retry negotiation", async () => {
  for (const [overrides, message] of [
    [{ board: "other.board" }, "board mismatch"],
    [{ protocol: 2 }, "protocol mismatch"],
    [{ maxBytes: 2 }, "bundle exceeds device maxBytes"],
  ]) {
    const fake = fakeRuntime();
    const pending = runDevicePush(bundle, "/dev/cu.fake", fake.runtime);
    await settleTasks();
    fake.emit(rdy(5, overrides));
    await assert.rejects(pending, { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message });
    assert.equal(fake.writes.filter((line) => line.startsWith("TSXB BEGIN")).length, 1);
    assert.equal(fake.writes.filter((line) => line === "TSXB ABORT").length, 1);
    assert.equal(fake.closeCalls, 1);
  }
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

test("serial resource close destroys the output immediately", async () => {
  let destroyed = false;
  await closeSerialResources({
    lines: { close() {} },
    input: { destroy() {} },
    output: { destroyed: false, destroy: () => { destroyed = true; } },
  });
  assert.equal(destroyed, true);
});
