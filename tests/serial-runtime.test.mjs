import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";
import { closeSerialResources, NODE_SERIAL_RUNTIME } from "../packages/sdk/dist/serial.js";

/**
 * `NODE_SERIAL_RUNTIME.open` shells out to the real `stty` binary before it
 * ever touches Node streams. These tests inject a throwaway `stty` on PATH so
 * the "configuration succeeded" branch is exercised without a real serial
 * device or hardware dependency.
 */
async function withFakeStty(exitCode, fn) {
  const bin = mkdtempSync(join(tmpdir(), "tsx-lvgl-fake-stty-"));
  writeFileSync(join(bin, "stty"), `#!/bin/sh\nexit ${exitCode}\n`);
  chmodSync(join(bin, "stty"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

function waitFor(channel, event) {
  return new Promise((resolve) => {
    const unsubscribe = channel[event]((value) => {
      unsubscribe();
      resolve(value);
    });
  });
}

function mkfifoAt(path) {
  const result = spawnSync("mkfifo", [path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/**
 * A regular file cannot double as both read and write fixtures: opening it
 * for write (`createWriteStream`'s default truncating flag) races the read
 * side and can erase content before it is read. A FIFO has no such race —
 * both ends belong to this same process, so a write is observable as a line
 * on the paired read side, exactly like a real character device.
 */
test("NODE_SERIAL_RUNTIME opens a full duplex line channel over a FIFO when stty configuration succeeds", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-serial-fifo-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const devicePath = join(sandbox, "fake-serial-device");
  mkfifoAt(devicePath);

  await withFakeStty(0, async () => {
    const channel = NODE_SERIAL_RUNTIME.open(devicePath);
    const lines = [];
    const unsubscribeLine = channel.onLine((line) => lines.push(line));
    const errors = [];
    const unsubscribeError = channel.onError((error) => errors.push(error));

    await channel.write("boot line one");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(lines, ["boot line one"]);

    await channel.close();
    await channel.close();
    await channel.write("after close is a no-op");

    unsubscribeLine();
    unsubscribeError();
    assert.deepEqual(errors, []);
  });
});

/**
 * Opening the same missing path for read and write races the write side's
 * create-on-open against the read side's open-for-read, so its outcome is
 * nondeterministic. A read-only file removes the race: the read side opens
 * cleanly, and the write side deterministically fails with EACCES, which is
 * forwarded through `onError` exactly like a real disconnect would be.
 */
test("NODE_SERIAL_RUNTIME reports asynchronous stream errors through onError", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-serial-readonly-"));
  const readonlyPath = join(sandbox, "read-only-device");
  writeFileSync(readonlyPath, "");
  chmodSync(readonlyPath, 0o444);
  t.after(() => {
    chmodSync(readonlyPath, 0o644);
    rmSync(sandbox, { recursive: true, force: true });
  });

  await withFakeStty(0, async () => {
    const channel = NODE_SERIAL_RUNTIME.open(readonlyPath);
    const error = await waitFor(channel, "onError");
    assert.equal(error.code, "EACCES");
    await channel.close();
  });
});

test("NODE_SERIAL_RUNTIME rejects a pending write when the underlying stream fails to open", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-serial-write-error-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const directoryPath = join(sandbox, "not-a-file");
  mkdirSync(directoryPath);

  await withFakeStty(0, async () => {
    const channel = NODE_SERIAL_RUNTIME.open(directoryPath);
    const errors = [];
    const unsubscribeError = channel.onError((error) => errors.push(error));
    await assert.rejects(channel.write("boom"));
    unsubscribeError();
    await channel.close().catch(() => {});
  });
});

test("NODE_SERIAL_RUNTIME skips stty configuration for Windows-shaped ports", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-serial-windows-"));
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    rmSync(sandbox, { recursive: true, force: true });
  });
  process.chdir(sandbox);
  mkfifoAt(join(sandbox, "COM3"));

  const channel = NODE_SERIAL_RUNTIME.open("COM3");
  const lines = [];
  channel.onLine((line) => lines.push(line));
  await channel.write("windows loopback");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(lines, ["windows loopback"]);
  await channel.close();
});

test("NODE_SERIAL_RUNTIME surfaces stty configuration failures without opening the port", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-serial-stty-fail-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const target = join(sandbox, "fake-device");

  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.throws(() => NODE_SERIAL_RUNTIME.open(target), { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED });
  } finally {
    process.env.PATH = previousPath;
  }

  await withFakeStty(1, async () => {
    assert.throws(
      () => NODE_SERIAL_RUNTIME.open(target),
      { code: DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, message: /stty exited 1/ },
    );
  });
});

test("closeSerialResources rejects when any underlying resource throws while closing", async () => {
  await assert.rejects(
    closeSerialResources({
      lines: { close() { throw new Error("lines boom"); } },
      input: { destroy() {} },
      output: { destroyed: false, destroy() {} },
    }),
    /lines boom/,
  );
  await assert.rejects(
    closeSerialResources({
      lines: { close() {} },
      input: { destroy() { throw new Error("input boom"); } },
      output: { destroyed: false, destroy() {} },
    }),
    /input boom/,
  );
  await assert.rejects(
    closeSerialResources({
      lines: { close() {} },
      input: { destroy() {} },
      output: { destroyed: false, destroy() { throw new Error("output boom"); } },
    }),
    /output boom/,
  );
  await closeSerialResources({
    lines: { close() {} },
    input: { destroy() {} },
    output: { destroyed: true, destroy() { throw new Error("must not be called"); } },
  });
});

/**
 * The POSIX read-poll branch (`openPosixSerialInput`) only activates for a
 * literal `/dev/cu.*` or `/dev/tty.*` path, and the sandbox has no write
 * access under `/dev` to fabricate one (root-owned devfs). macOS always
 * exposes a harmless, non-hardware virtual debug console at this path with
 * world read/write permissions; it is used here, guarded by an existence and
 * platform check, purely to exercise the nonblocking poll/EAGAIN loop.
 */
const posixSerialFixture = "/dev/cu.debug-console";
test(
  "NODE_SERIAL_RUNTIME polls a POSIX-shaped serial device without blocking on EAGAIN",
  { skip: process.platform !== "darwin" || !existsSync(posixSerialFixture) ? "no POSIX serial fixture available on this platform" : false },
  async () => {
    await withFakeStty(0, async () => {
      const channel = NODE_SERIAL_RUNTIME.open(posixSerialFixture);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await channel.write("probe\n");
      await channel.close();
    });
  },
);
