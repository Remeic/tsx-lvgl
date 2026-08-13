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
import { NODE_SERIAL_RUNTIME, type SerialRuntime, validateSerialPort } from "./serial.js";

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
    const pendingIo = new Set<(reason: CliError) => void>();

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
    const cancelPendingIo = () => {
      const cancellation = new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, "serial operation cancelled");
      for (const cancel of [...pendingIo]) cancel(cancellation);
    };
    const detach = () => {
      cancelTimer();
      cancelPendingIo();
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
    const boundedIo = <T>(label: "write" | "close", operation: () => T | Promise<T>): Promise<T> => new Promise<T>((resolveIo, rejectIo) => {
      let finished = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }) => {
        if (finished) return;
        finished = true;
        pendingIo.delete(cancel);
        if (deadline !== undefined) {
          try {
            runtime.clearTimer(deadline);
          } catch {
            // The finished flag fences a late deadline callback.
          }
        }
        outcome.ok ? resolveIo(outcome.value) : rejectIo(outcome.error);
      };
      const cancel = (reason: CliError) => finish({ ok: false, error: reason });
      pendingIo.add(cancel);
      const operationPromise = Promise.resolve().then(operation);
      // Both handlers stay attached after a timeout/cancellation, so a late
      // stream rejection is observed rather than becoming unhandled.
      operationPromise.then(
        (value) => finish({ ok: true, value }),
        (error: unknown) => finish({ ok: false, error }),
      );
      try {
        const armedDeadline = runtime.setTimer(
          () => finish({ ok: false, error: new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, `serial ${label} timed out`) }),
          ackTimeoutMs,
        );
        deadline = armedDeadline;
        if (finished) {
          try {
            runtime.clearTimer(armedDeadline);
          } catch {
            // The finished flag still fences a synchronously fired callback.
          }
        }
      } catch (error) {
        finish({ ok: false, error });
      }
    });
    const writeFrame = (frame: string): Promise<void> => boundedIo("write", () => channel.write(frame));
    const closeBestEffort = async (): Promise<unknown> => {
      try {
        await boundedIo("close", () => channel.close());
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const fail = async (error: unknown): Promise<void> => {
      if (settled) return;
      settled = true;
      const primaryError = asDeviceError(error);
      detach();
      try {
        await writeFrame("TSXB ABORT");
      } catch {
        // The primary failure wins; ABORT is explicitly best-effort.
      }
      await closeBestEffort();
      reject(primaryError);
    };
    const succeed = async (progress: PushProgress): Promise<void> => {
      /* node:coverage disable */
      // Unreachable: succeed is only invoked synchronously from apply's own "done" branch right
      // after apply's identical settled-check, with no await in between (handleOk always sends
      // an empty frame list for "done"), so settled cannot flip between the two checks.
      if (settled) return;
      // Unreachable through the real protocol: the bundler's handleOk always sets result before state becomes "done".
      if (progress.result === undefined) {
        await fail(new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, "device push ended without a result"));
        return;
      }
      /* node:coverage enable */
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
      /* node:coverage disable */
      // Unreachable: every caller is already gated by an identical settled-check with no await
      // in between (the enqueue wrapper's own "!settled" guard, or a synchronous check inside the
      // same closure), and any in-flight write that could otherwise create a gap is force-rejected
      // by cancelPendingIo the instant a concurrent fail()/succeed() sets settled, so no caller can
      // ever resume past that gap with settled newly true.
      if (settled) return;
      /* node:coverage enable */
      state = progress.state;
      if (progress.state === "failed") {
        // The pure session represents failure with an ABORT frame. Delegate
        // that best-effort write to `fail` so an I/O timeout cannot replace
        // the protocol failure that caused it.
        await fail(new CliError(DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED, progress.failure ?? "device push failed"));
        return;
      }
      for (const frame of progress.send) {
        await writeFrame(frame);
      }
      if (progress.state === "done") {
        await succeed(progress);
        return;
      }
      arm(progress);
    };
    const retryWith = async (lastGeneration: number, rejectedProgress: PushProgress): Promise<void> => {
      if (retryCount >= 1 || !Number.isSafeInteger(lastGeneration) || lastGeneration >= Number.MAX_SAFE_INTEGER) {
        await apply(rejectedProgress);
        return;
      }
      // The current device state owns the staging buffer. Abort before the
      // next BEGIN, then immediately make the one fresh, monotonic attempt.
      cancelTimer();
      await writeFrame("TSXB ABORT");
      retryCount += 1;
      manifest = { ...manifest, generation: lastGeneration + 1 };
      session = createPushSession(manifest, bundle.bytes);
      await apply(session.begin());
    };
    const handleProtocolLine = async (line: string, parsed: Exclude<ReturnType<typeof parseDeviceLine>, { readonly kind: "noise" }>): Promise<void> => {
      if (parsed.kind === "rdy" && state !== "awaiting-rdy") return;
      const progress = session.handle({ kind: "line", line });
      // Let the pure session validate maxBytes/protocol/board first. Only its
      // exact monotonicity failure authorizes the wrapper's one fresh attempt.
      if (parsed.kind === "rdy" && progress.state === "failed" && progress.failure === "generation not monotonic") {
        await retryWith(parsed.lastGeneration, progress);
        return;
      }
      await apply(progress);
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
      unsubscribeError = channel.onError((error) => {
        // An I/O error must not queue behind a hung write. `fail` cancels that
        // bounded operation and owns exactly-once abort/close settlement.
        void fail(error).catch(() => {});
      });
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
