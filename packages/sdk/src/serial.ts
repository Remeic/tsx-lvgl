import { closeSync, constants as fsConstants, createReadStream, createWriteStream, openSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";

/**
 * A deliberately small line-oriented serial seam. The TSXB protocol is pure
 * and lives in the bundler; this module owns only the Node-specific device
 * handle so tests can supply an in-memory channel.
 */
export interface SerialLineChannel {
  write(line: string): void | Promise<void>;
  onLine(listener: (line: string) => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
  close(): void | Promise<void>;
}

export interface SerialRuntime {
  open(port: string): SerialLineChannel;
}

interface ClosableSerialResources {
  readonly lines: { close(): void };
  readonly input: { destroy(): void };
  readonly output: { readonly destroyed: boolean; destroy(): void };
}

const POSIX_SERIAL_PORT = /^\/dev\/(?:cu|tty)\.[A-Za-z0-9._-]+$/;
const WINDOWS_SERIAL_PORT = /^COM[1-9][0-9]*$/i;
const SERIAL_READ_BUFFER_BYTES = 1024;
const SERIAL_READ_POLL_MS = 20;

/** Validates only a machine-local endpoint; it neither opens nor persists it. */
export function validateSerialPort(port: string | undefined): string {
  if (port === undefined || !POSIX_SERIAL_PORT.test(port) && !WINDOWS_SERIAL_PORT.test(port)) {
    throw new CliError(
      DIAGNOSTIC_CODES.DEVICE_PORT_INVALID,
      "--port must be a local /dev/cu.*, /dev/tty.* or COM<n> serial device",
    );
  }
  return port;
}

/**
 * Opens a 115200 raw console without flashing, resetting, or otherwise
 * changing firmware state. It is intentionally not invoked by `doctor`.
 */
export const NODE_SERIAL_RUNTIME: SerialRuntime = {
  open(port: string): SerialLineChannel {
    configurePort(port);
    // The POSIX input branch requires a platform-specific device fixture; its poll loop is covered separately where that fixture exists.
    /* node:coverage ignore next */
    const input = POSIX_SERIAL_PORT.test(port) ? openPosixSerialInput(port) : createReadStream(port);
    const output = createWriteStream(port);
    const lines = createInterface({ input, crlfDelay: Infinity });
    const lineListeners = new Set<(line: string) => void>();
    const errorListeners = new Set<(error: unknown) => void>();
    let closed = false;

    const emitError = (error: unknown) => {
      for (const listener of errorListeners) listener(error);
    };
    input.on("error", emitError);
    output.on("error", emitError);
    lines.on("line", (line) => {
      for (const listener of lineListeners) listener(line);
    });

    return {
      write(line: string): Promise<void> {
        if (closed) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          output.write(`${line}\n`, (error) => error === null || error === undefined ? resolve() : reject(error));
        });
      },
      onLine(listener: (line: string) => void): () => void {
        lineListeners.add(listener);
        return () => lineListeners.delete(listener);
      },
      onError(listener: (error: unknown) => void): () => void {
        errorListeners.add(listener);
        return () => errorListeners.delete(listener);
      },
      close(): Promise<void> {
        if (closed) return Promise.resolve();
        closed = true;
        return closeSerialResources({ lines, input, output });
      },
    };
  },
};

/**
 * macOS can block a path-based tty open before Node receives a stream handle.
 * Open nonblocking and poll the descriptor so a closed device session cannot
 * leave the CLI stuck in an uninterruptible read.
 */
/* node:coverage disable */
// Coverage requires a real serial device: the poll loop's data, backpressure, and close-race
// branches only fire with hardware timing. Functionally exercised by the macOS-only loopback
// test in tests/serial-runtime.test.mjs; excluded so coverage stays deterministic across platforms.
function openPosixSerialInput(port: string): Readable {
  const descriptor = openSync(port, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  return new Readable({
    read() {
      if (polling || closed) return;
      polling = true;

      const poll = () => {
        if (closed || this.destroyed) {
          polling = false;
          return;
        }

        const buffer = Buffer.allocUnsafe(SERIAL_READ_BUFFER_BYTES);
        let bytesRead = 0;
        try {
          bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
        } catch (error) {
          const code = error instanceof Error && "code" in error ? error.code : undefined;
          if (code !== "EAGAIN" && code !== "EWOULDBLOCK") {
            polling = false;
            this.destroy(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }

        if (bytesRead > 0 && !this.push(buffer.subarray(0, bytesRead))) {
          polling = false;
          return;
        }
        pollTimer = setTimeout(poll, SERIAL_READ_POLL_MS);
      };

      poll();
    },
    destroy(error, callback) {
      closed = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      let closeError: unknown;
      try {
        closeSync(descriptor);
      } catch (closeFailure) {
        closeError = closeFailure;
      }
      callback(error ?? (closeError instanceof Error ? closeError : undefined));
    },
  });
}
/* node:coverage enable */

/** Closes the three Node resources as one observable async operation. */
export function closeSerialResources({ lines, input, output }: ClosableSerialResources): Promise<void> {
  try {
    lines.close();
  } catch (error) {
    return Promise.reject(error);
  }
  try {
    input.destroy();
  } catch (error) {
    return Promise.reject(error);
  }
  try {
    if (!output.destroyed) output.destroy();
  } catch (error) {
    return Promise.reject(error);
  }
  return Promise.resolve();
}

function configurePort(port: string): void {
  // Windows does not have stty. Node stream opening is its portable preflight.
  if (WINDOWS_SERIAL_PORT.test(port)) return;
  const result = spawnSync("stty", ["-f", port, "115200", "raw", "-echo"], { stdio: "ignore" });
  if (result.error !== undefined || result.status !== 0) {
    throw new CliError(
      DIAGNOSTIC_CODES.DEVICE_PUSH_FAILED,
      `serial configuration failed: ${result.error?.message ?? `stty exited ${result.status}`}`,
    );
  }
}
