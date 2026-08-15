import assert from "node:assert/strict";
import test from "node:test";

import { runDeviceWatch } from "../packages/sdk/dist/device-watch.js";
import { parseCli as parseWatchCli } from "../scripts/watch-push.mjs";

const bundle = (generation) => ({
  manifest: {
    protocolVersion: 1,
    bundleId: "app",
    boardId: "waveshare-v1",
    generation,
    byteLength: 1,
    sha256: generation.toString(16).padStart(64, "0"),
  },
  bytes: new Uint8Array([generation]),
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached");
};

test("watch-push CLI requires a TSX entry and local serial port", () => {
  assert.deepEqual(
    parseWatchCli(["--entry", "src/App.tsx", "--port", "/dev/cu.usbmodem1101"]),
    {
      help: false,
      options: {
        entry: "src/App.tsx",
        port: "/dev/cu.usbmodem1101",
        bundleId: "app",
        generation: 1,
        boardId: "waveshare.esp32s3.touch-amoled-1.8",
      },
    },
  );
  assert.throws(() => parseWatchCli(["--entry", "app.tsx", "--port", "remote:1234"]), /local/);
});

test("device watch coalesces saves and serializes monotonic pushes", async () => {
  const controller = new AbortController();
  const changes = [];
  const pushed = [];
  const accepted = [];
  const secondPush = deferred();
  let activePushes = 0;
  let maxActivePushes = 0;

  const running = runDeviceWatch({
    initialGeneration: 1,
    debounceMs: 0,
    signal: controller.signal,
    watch: (onChange) => {
      changes.push(onChange);
      return { close() {} };
    },
    build: async (generation) => bundle(generation),
    push: async (next) => {
      activePushes += 1;
      maxActivePushes = Math.max(maxActivePushes, activePushes);
      pushed.push(next.manifest.generation);
      if (pushed.length === 2) await secondPush.promise;
      activePushes -= 1;
      return { bundleId: "app", generation: next.manifest.generation, epoch: pushed.length, retryCount: 0 };
    },
    onAccepted: (result) => accepted.push(result.generation),
    onRejected: (error) => assert.fail(error.message),
  });

  await waitFor(() => accepted.length === 1);
  changes[0]();
  changes[0]();
  await waitFor(() => pushed.length === 2);
  changes[0]();
  secondPush.resolve();
  await waitFor(() => accepted.length === 3);
  controller.abort();
  await running;

  assert.deepEqual(pushed, [1, 2, 3]);
  assert.deepEqual(accepted, [1, 2, 3]);
  assert.equal(maxActivePushes, 1);
});

test("device watch keeps the accepted app after a compile error and recovers on the next save", async () => {
  const controller = new AbortController();
  let change;
  let buildCount = 0;
  const accepted = [];
  const rejected = [];
  const running = runDeviceWatch({
    initialGeneration: 4,
    debounceMs: 0,
    signal: controller.signal,
    watch: (listener) => {
      change = listener;
      return { close() {} };
    },
    build: async (generation) => {
      buildCount += 1;
      if (buildCount === 2) throw new Error("TSX does not compile");
      return bundle(generation);
    },
    push: async (next) => ({ bundleId: "app", generation: next.manifest.generation, epoch: accepted.length + 1, retryCount: 0 }),
    onAccepted: (result) => accepted.push(result.generation),
    onRejected: (error) => rejected.push(error.message),
  });

  await waitFor(() => accepted.length === 1);
  change();
  await waitFor(() => rejected.length === 1);
  change();
  await waitFor(() => accepted.length === 2);
  controller.abort();
  await running;

  assert.deepEqual(accepted, [4, 5]);
  assert.deepEqual(rejected, ["TSX does not compile"]);
});

test("device watch ignores duplicate notifications when compiled content is unchanged", async () => {
  const controller = new AbortController();
  let change;
  let pushes = 0;
  let builds = 0;
  const running = runDeviceWatch({
    initialGeneration: 1,
    debounceMs: 0,
    signal: controller.signal,
    watch: (listener) => {
      change = listener;
      return { close() {} };
    },
    build: async () => {
      builds += 1;
      return bundle(1);
    },
    push: async (next) => {
      pushes += 1;
      return { bundleId: "app", generation: next.manifest.generation, epoch: pushes, retryCount: 0 };
    },
    onAccepted: () => {},
    onRejected: (error) => assert.fail(error.message),
  });

  await waitFor(() => pushes === 1);
  change();
  await waitFor(() => builds === 2);
  change();
  await waitFor(() => builds === 3);
  controller.abort();
  await running;
  assert.equal(pushes, 1);
});
