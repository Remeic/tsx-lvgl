import {
  ACK_TIMEOUT_MS,
  COMMIT_TIMEOUT_MS,
  createPushSession,
  parseDeviceLine,
  type PushProgress,
  type PushState,
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
  return new Promise<DeviceDevResult>((resolve, reject) => {
    let settled = false;
    let retryCount = 0;
    let manifest = bundle.manifest;
    let session = createPushSession(manifest, bundle.bytes);
    let state: PushState = "awaiting-rdy";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timerToken = 0;
    let unsubscribeLine: (() => void) | undefined;
    let unsubscribeError: (() => void) | undefined;
    let eventQueue = Promise.resolve();

    const cancelTimer = () => {
      timerToken += 1;
      if (timer === undefined) return;
      try {
        runtime.clearTimer(timer);
      } catch {
        // A stale callback is still fenced by timerToken.
      }
      timer = undefined;
    };
    const detach = () => {
      cancelTimer();
      try {
        unsubscribeLine?.();
      } catch {
        // Best-effort listener cleanup; settlement must still complete.
      }
      try {
        unsubscribeError?.();
      } catch {
        // Best-effort listener cleanup; settlement must still complete.
      }
    };
    const asDeviceError = (error: unknown): CliError => error instanceof CliError
      ? error
      : new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, error instanceof Error ? error.message : String(error));
    const closeBestEffort = async (): Promise<unknown> => {
      try {
        await channel.close();
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const fail = async (error: unknown, abortAlreadySent = false): Promise<void> => {
      if (settled) return;
      settled = true;
      const primaryError = asDeviceError(error);
      detach();
      if (!abortAlreadySent) {
        try {
          await channel.write("TSXB ABORT");
        } catch {
          // The primary failure wins; ABORT is explicitly best-effort.
        }
      }
      await closeBestEffort();
      reject(primaryError);
    };
    const succeed = async (progress: PushProgress): Promise<void> => {
      if (settled) return;
      if (progress.result === undefined) {
        await fail(new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, "device push ended without a result"));
        return;
      }
      settled = true;
      detach();
      const closeError = await closeBestEffort();
      if (closeError !== undefined) {
        reject(asDeviceError(closeError));
        return;
      }
      resolve({
        bundleId: manifest.bundleId,
        generation: progress.result.generation,
        epoch: progress.result.epoch,
        retryCount,
      });
    };
    const arm = (progress: PushProgress): void => {
      cancelTimer();
      const token = timerToken;
      const timeoutMs = progress.state === "awaiting-commit" ? commitTimeoutMs : ackTimeoutMs;
      timer = runtime.setTimer(() => {
        if (settled || token !== timerToken) return;
        enqueue(async () => {
          if (token !== timerToken) return;
          await apply(session.handle({ kind: "timeout" }));
        });
      }, timeoutMs);
    };
    const apply = async (progress: PushProgress): Promise<void> => {
      if (settled) return;
      state = progress.state;
      let abortSent = false;
      for (const frame of progress.send) {
        await channel.write(frame);
        if (frame === "TSXB ABORT") abortSent = true;
      }
      if (progress.state === "done") {
        await succeed(progress);
        return;
      }
      if (progress.state === "failed") {
        await fail(new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, progress.failure ?? "device push failed"), abortSent);
        return;
      }
      arm(progress);
    };
    const retryWith = async (lastGeneration: number): Promise<void> => {
      if (retryCount >= 1 || !Number.isSafeInteger(lastGeneration) || lastGeneration >= Number.MAX_SAFE_INTEGER) {
        await apply(session.handle({ kind: "line", line: `TSXB RDY maxBytes=${manifest.byteLength} protocol=${manifest.protocolVersion} board=${manifest.boardId} lastGeneration=${lastGeneration}` }));
        return;
      }
      // The current device state owns the staging buffer. Abort before the
      // next BEGIN, then immediately make the one fresh, monotonic attempt.
      cancelTimer();
      await channel.write("TSXB ABORT");
      retryCount += 1;
      manifest = { ...manifest, generation: lastGeneration + 1 };
      session = createPushSession(manifest, bundle.bytes);
      await apply(session.begin());
    };
    const handleProtocolLine = async (line: string, parsed: Exclude<ReturnType<typeof parseDeviceLine>, { readonly kind: "noise" }>): Promise<void> => {
      if (parsed.kind === "rdy") {
        // createPushSession deliberately ignores RDY outside its handshake.
        // Check the wrapper's generation negotiation under the same rule.
        if (state !== "awaiting-rdy") return;
        if (manifest.generation <= parsed.lastGeneration) {
          await retryWith(parsed.lastGeneration);
          return;
        }
      }
      await apply(session.handle({ kind: "line", line }));
    };
    const enqueue = (action: () => Promise<void>): void => {
      eventQueue = eventQueue
        .then(async () => {
          if (!settled) await action();
        })
        .catch(async (error: unknown) => {
          await fail(error);
        });
    };

    try {
      unsubscribeLine = channel.onLine((line) => {
        if (settled) return;
        const parsed = parseDeviceLine(line);
        // Noise is ignored before queueing, so it cannot extend a deadline or
        // grow the protocol work queue under a continuous device log stream.
        if (parsed.kind === "noise") return;
        enqueue(async () => handleProtocolLine(line, parsed));
      });
      unsubscribeError = channel.onError((error) => enqueue(async () => fail(error)));
      enqueue(async () => apply(session.begin()));
    } catch (error) {
      void fail(error);
    }
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
