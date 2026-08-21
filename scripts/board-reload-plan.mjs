import { isAbsolute } from "node:path";

import { assertValidatedLiveLayout } from "./board-artifact-descriptor.mjs";

const ALLOWED_RESET_MODES = new Set(["hard-reset", "watchdog-reset"]);
const SERIAL_PORT_PATTERN = /^\/dev\/(?:cu|tty)\.[A-Za-z0-9._-]+$/;

export const FORBIDDEN_RELOAD_OPERATIONS = Object.freeze([
  "erase-flash",
  "erase-region",
  "burn-*",
  "write-protect-efuse",
  "read-protect-efuse",
]);

export function formatFlashAddress(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("flash address must be a non-negative safe integer");
  }
  return `0x${value.toString(16)}`;
}

function validateBaseConfig({ esptoolPython, port, artifact, baud, resetMode }) {
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

function validateLiveReadConfig({ partitionTableOffset, partitionTableReadSize, livePartitionTablePath }) {
  if (!Number.isSafeInteger(partitionTableOffset) || partitionTableOffset < 0) {
    throw new Error("partition-table flash offset must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(partitionTableReadSize) || partitionTableReadSize <= 0) {
    throw new Error("partition-table read size must be a positive safe integer");
  }
  if (!isAbsolute(livePartitionTablePath) || livePartitionTablePath.length === 0) {
    throw new Error("live partition-table path must be a non-empty absolute path");
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

function preflightSteps(config) {
  const esptool = (before, after, ...command) => esptoolCommand(config, before, after, ...command);
  return [
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
      name: "read-partition-table",
      kind: "preflight",
      command: esptool(
        "no-reset",
        "no-reset",
        "read-flash",
        formatFlashAddress(config.partitionTableOffset),
        formatFlashAddress(config.partitionTableReadSize),
        config.livePartitionTablePath,
      ),
    },
  ];
}

/**
 * Construct only commands that read device state. No mutation command is
 * represented by this object or constructed as a side effect.
 */
export function buildReloadPreflightPlan(config) {
  const normalizedConfig = {
    ...config,
    partitionTableOffset: config.partitionTableOffset ?? config.tableOffset,
    partitionTableReadSize: config.partitionTableReadSize ?? config.readSize,
    livePartitionTablePath: config.livePartitionTablePath ?? config.liveTablePath ?? config.tablePath,
  };
  validateBaseConfig(normalizedConfig);
  validateLiveReadConfig(normalizedConfig);
  return Object.freeze({
    mutationScope: "application-only after validated live partition layout",
    liveLayoutGate: Object.freeze({
      flashOffset: normalizedConfig.partitionTableOffset,
      readSize: normalizedConfig.partitionTableReadSize,
    }),
    forbiddenOperations: FORBIDDEN_RELOAD_OPERATIONS,
    steps: Object.freeze(preflightSteps(normalizedConfig).map((step) => Object.freeze({
      ...step,
      command: Object.freeze([...step.command]),
    }))),
  });
}

/**
 * Construct mutation commands only from the opaque success value returned by
 * compareLivePartitionTable(). An unchecked offset or size cannot satisfy the
 * private brand check in assertValidatedLiveLayout().
 */
export function buildReloadMutationPlan(config, validatedLayout) {
  validateBaseConfig(config);
  assertValidatedLiveLayout(validatedLayout);
  if (config.artifactByteLength !== undefined && config.artifactByteLength !== validatedLayout.artifactByteLength) {
    throw new Error("artifact byte length differs from the validated live-layout result");
  }
  const esptool = (before, after, ...command) => esptoolCommand(config, before, after, ...command);
  const offset = formatFlashAddress(validatedLayout.applicationPartition.offset);
  const steps = [
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
        offset,
        config.artifact,
      ),
    },
    {
      name: "verify-flash",
      kind: "verification",
      command: esptool("no-reset", "no-reset", "verify-flash", offset, config.artifact),
    },
    {
      name: "reset",
      kind: "launch",
      command: esptool("no-reset", config.resetMode, "chip-id"),
    },
  ];
  return Object.freeze({
    mutationScope: `application-only at ${offset}`,
    liveLayout: validatedLayout,
    forbiddenOperations: FORBIDDEN_RELOAD_OPERATIONS,
    steps: Object.freeze(steps.map((step) => Object.freeze({
      ...step,
      command: Object.freeze([...step.command]),
    }))),
  });
}

export { ALLOWED_RESET_MODES, SERIAL_PORT_PATTERN };
