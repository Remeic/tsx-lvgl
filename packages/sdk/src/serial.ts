import { createReadStream, createWriteStream } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

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

const POSIX_SERIAL_PORT = /^\/dev\/(?:cu|tty)\.[A-Za-z0-9._-]+$/;
const WINDOWS_SERIAL_PORT = /^COM[1-9][0-9]*$/i;

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
    const input = createReadStream(port);
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
        return new Promise<void>((resolve, reject) => {
          let synchronousError: unknown;
          try {
            lines.close();
          } catch (error) {
            synchronousError = error;
          }
          try {
            input.destroy();
          } catch (error) {
            synchronousError ??= error;
          }
          try {
            if (output.destroyed) {
              synchronousError === undefined ? resolve() : reject(synchronousError);
            } else {
              output.end(() => synchronousError === undefined ? resolve() : reject(synchronousError));
            }
          } catch (error) {
            reject(synchronousError ?? error);
          }
        });
      },
    };
  },
};

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
