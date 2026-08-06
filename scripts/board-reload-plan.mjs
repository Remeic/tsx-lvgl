import { isAbsolute } from "node:path";

export const APP_FLASH_OFFSET = "0x10000";

const ALLOWED_RESET_MODES = new Set(["hard-reset", "watchdog-reset"]);
const SERIAL_PORT_PATTERN = /^\/dev\/(?:cu|tty)\.[A-Za-z0-9._-]+$/;

function validateConfig({ esptoolPython, port, artifact, baud, resetMode }) {
  if (!isAbsolute(esptoolPython)) {
    throw new Error("esptool Python path must be absolute");
  }
  if (!SERIAL_PORT_PATTERN.test(port)) {
    throw new Error("serial port must be a /dev/cu.* or /dev/tty.* device");
  }
  if (!isAbsolute(artifact) || artifact.length === 0) {
    throw new Error("artifact must be a non-empty absolute path");
  }
  if (!Number.isInteger(baud) || baud <= 0) {
    throw new Error("baud must be a positive integer");
  }
  if (!ALLOWED_RESET_MODES.has(resetMode)) {
    throw new Error(`unsupported reset mode: ${resetMode}`);
  }
}

function esptoolCommand({ esptoolPython, port, baud }, before, after, ...command) {
  return [
    esptoolPython,
    "-m",
    "esptool",
    "--chip",
    "esp32s3",
    "--port",
    port,
    "--baud",
    String(baud),
    "--before",
    before,
    "--after",
    after,
    ...command,
  ];
}

function espefuseCommand({ esptoolPython, port, baud }, command) {
  return [
    esptoolPython,
    "-m",
    "espefuse",
    "--chip",
    "esp32s3",
    "--port",
    port,
    "--baud",
    String(baud),
    "--before",
    "no-reset",
    "--after",
    "no-reset",
    command,
  ];
}

/**
 * Build the complete, non-destructive-by-default reload sequence.
 *
 * The returned commands are data, not execution. The runner is responsible
 * for creating the external recovery log before invoking the first command.
 */
export function buildReloadPlan(config) {
  validateConfig(config);

  const { artifact, resetMode } = config;
  const esptool = (before, after, ...command) =>
    esptoolCommand(config, before, after, ...command);

  return {
    mutationScope: `application-only at ${APP_FLASH_OFFSET}`,
    forbiddenOperations: [
      "erase-flash",
      "erase-region",
      "burn-*",
      "write-protect-efuse",
      "read-protect-efuse",
    ],
    steps: [
      {
        name: "chip-id",
        kind: "preflight",
        command: esptool("default-reset", "no-reset", "chip-id"),
      },
      {
        name: "flash-id",
        kind: "preflight",
        command: esptool("no-reset", "no-reset", "flash-id"),
      },
      {
        name: "read-mac",
        kind: "preflight",
        command: esptool("no-reset", "no-reset", "read-mac"),
      },
      {
        name: "security-info",
        kind: "preflight",
        command: esptool("no-reset", "no-reset", "get-security-info"),
      },
      {
        name: "efuse-summary",
        kind: "preflight",
        command: espefuseCommand(config, "summary"),
      },
      {
        name: "efuse-dump",
        kind: "preflight",
        command: espefuseCommand(config, "dump"),
      },
      {
        name: "write-flash",
        kind: "mutation",
        mutation: "app-only",
        command: esptool(
          "no-reset",
          "no-reset",
          "write-flash",
          "--flash-mode",
          "keep",
          "--flash-freq",
          "keep",
          "--flash-size",
          "keep",
          APP_FLASH_OFFSET,
          artifact,
        ),
      },
      {
        name: "verify-flash",
        kind: "verification",
        command: esptool("no-reset", "no-reset", "verify-flash", APP_FLASH_OFFSET, artifact),
      },
      {
        name: "reset",
        kind: "launch",
        command: esptool("no-reset", resetMode, "chip-id"),
      },
    ],
  };
}
