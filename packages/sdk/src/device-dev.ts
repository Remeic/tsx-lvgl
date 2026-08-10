import {
  ACK_TIMEOUT_MS,
  COMMIT_TIMEOUT_MS,
  createPushSession,
  parseDeviceLine,
  type PushProgress,
} from "@tsx-lvgl/bundler";
import type { RuntimeBundleManifest } from "@tsx-lvgl/runtime";

import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";
import { NODE_SERIAL_RUNTIME, type SerialLineChannel, type SerialRuntime, validateSerialPort } from "./serial.js";

export interface DeviceDevResult {
  readonly bundleId: string;
  readonly generation: number;
  readonly epoch: number;
  /** Zero means the configured generation was already monotonic. */
  readonly retryCount: number;
}

export interface DevicePushBundle {
  readonly manifest: RuntimeBundleManifest;
  readonly bytes: Uint8Array;
}

export interface DeviceDevRuntime {
  readonly serial: SerialRuntime;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

export interface DevicePushTimeouts {
  readonly ackTimeoutMs?: number;
  readonly commitTimeoutMs?: number;
}

export const DEFAULT_DEVICE_DEV_RUNTIME: DeviceDevRuntime = {
  serial: NODE_SERIAL_RUNTIME,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

/**
 * Pushes exactly one compiled bundle without flashing or resetting a board.
 * If the board reports that the configured generation is stale, it aborts the
 * attempt and retries once with `lastGeneration + 1`. Nothing is persisted:
 * the negotiated generation belongs solely to this invocation.
 */
export async function runDevicePush(
  bundle: DevicePushBundle,
  portArgument: string,
  runtime: DeviceDevRuntime = DEFAULT_DEVICE_DEV_RUNTIME,
  timeouts: DevicePushTimeouts = {},
): Promise<DeviceDevResult> {
  const port = validateSerialPort(portArgument);
  const ackTimeoutMs = validTimeout(timeouts.ackTimeoutMs, ACK_TIMEOUT_MS, "ackTimeoutMs");
  const commitTimeoutMs = validTimeout(timeouts.commitTimeoutMs, COMMIT_TIMEOUT_MS, "commitTimeoutMs");
  const channel = runtime.serial.open(port);
  return await new Promise<DeviceDevResult>((resolve, reject) => {
    let closed = false;
    let retryCount = 0;
    let manifest = bundle.manifest;
    let session = createPushSession(manifest, bundle.bytes);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeLine: (() => void) | undefined;
    let unsubscribeError: (() => void) | undefined;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) runtime.clearTimer(timer);
      unsubscribeLine?.();
      unsubscribeError?.();
      channel.close();
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error instanceof CliError
        ? error
        : new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, error instanceof Error ? error.message : String(error)));
    };
    const arm = (progress: PushProgress) => {
      if (timer !== undefined) runtime.clearTimer(timer);
      const timeoutMs = progress.state === "awaiting-commit" ? commitTimeoutMs : ackTimeoutMs;
      timer = runtime.setTimer(() => apply(session.handle({ kind: "timeout" })), timeoutMs);
    };
    const succeed = (progress: PushProgress) => {
      if (progress.result === undefined) return fail(new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, "device push ended without a result"));
      cleanup();
      resolve({
        bundleId: manifest.bundleId,
        generation: progress.result.generation,
        epoch: progress.result.epoch,
        retryCount,
      });
    };
    const apply = (progress: PushProgress) => {
      if (closed) return;
      for (const frame of progress.send) channel.write(frame);
      if (progress.state === "done") return succeed(progress);
      if (progress.state === "failed") return fail(new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, progress.failure ?? "device push failed"));
      arm(progress);
    };
    const retryWith = (lastGeneration: number) => {
      if (retryCount >= 1 || !Number.isSafeInteger(lastGeneration) || lastGeneration >= Number.MAX_SAFE_INTEGER) {
        apply(session.handle({ kind: "line", line: `TSXB RDY maxBytes=${manifest.byteLength} protocol=${manifest.protocolVersion} board=${manifest.boardId} lastGeneration=${lastGeneration}` }));
        return;
      }
      // The current device state owns the staging buffer. Abort before the
      // next BEGIN, then immediately make the one fresh, monotonic attempt.
      channel.write("TSXB ABORT");
      retryCount += 1;
      manifest = { ...manifest, generation: lastGeneration + 1 };
      session = createPushSession(manifest, bundle.bytes);
      apply(session.begin());
    };

    unsubscribeLine = channel.onLine((line) => {
      if (closed) return;
      const parsed = parseDeviceLine(line);
      if (parsed.kind === "rdy" && manifest.generation <= parsed.lastGeneration) {
        retryWith(parsed.lastGeneration);
        return;
      }
      apply(session.handle({ kind: "line", line }));
    });
    unsubscribeError = channel.onError(fail);
    apply(session.begin());
  });
}

export const runDeviceDev = runDevicePush;

/** Machine-local preflight for `doctor --device`; it never touches a port. */
export function doctorDevicePort(portArgument: string): string {
  validateSerialPort(portArgument);
  return "device serial port syntax is valid (not opened)";
}

function validTimeout(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, `${name} must be a positive number`);
  }
  return value;
}
