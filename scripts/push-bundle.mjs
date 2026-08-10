import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { ACK_TIMEOUT_MS, COMMIT_TIMEOUT_MS } from "@tsx-lvgl/bundler";
import { runDevicePush } from "../packages/sdk/dist/device-dev.js";

import { readFlagValue } from "./lib/cli.mjs";

// Mirrors SERIAL_PORT_PATTERN in scripts/board-reload-plan.mjs (not exported there).
const SERIAL_PORT_PATTERN = /^(?:\/dev\/(?:cu|tty)\.[A-Za-z0-9._-]+|COM[1-9][0-9]*)$/i;

class UsageError extends Error {}

function usage() {
  return `Usage:
  node scripts/push-bundle.mjs --port /dev/cu.usbmodemXXX --bundle <path.js> --manifest <path.json> [options]

Options:
  --port PATH             Serial device, /dev/cu.*, /dev/tty.* or COM<n> (required).
  --bundle PATH            Compiled JS bundle file (required).
  --manifest PATH          Bundle manifest JSON file (required).
  --ack-timeout MS         Override ACK_TIMEOUT_MS (default ${ACK_TIMEOUT_MS}).
  --commit-timeout MS      Override COMMIT_TIMEOUT_MS (default ${COMMIT_TIMEOUT_MS}).
  --help                   Show this help.

Dev-only transport (see docs/feature-specs/0010-runtime-tsx-hot-reload.md).
Not authenticated; do not use over an untrusted link.
`;
}

function parseCli(argv) {
  const options = {
    port: "",
    bundle: "",
    manifest: "",
    ackTimeoutMs: ACK_TIMEOUT_MS,
    commitTimeoutMs: COMMIT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      return { help: true, options };
    }

    let name, value, nextIndex;
    try {
      ({ name, value, nextIndex } = readFlagValue(argv, index));
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    index = nextIndex;

    switch (name) {
      case "--port":
        options.port = value;
        break;
      case "--bundle":
        options.bundle = value;
        break;
      case "--manifest":
        options.manifest = value;
        break;
      case "--ack-timeout":
        options.ackTimeoutMs = Number(value);
        break;
      case "--commit-timeout":
        options.commitTimeoutMs = Number(value);
        break;
      default:
        throw new UsageError(`unknown option: ${argument}`);
    }
  }

  if (!SERIAL_PORT_PATTERN.test(options.port)) {
    throw new UsageError("--port must be a local /dev/cu.*, /dev/tty.* or COM<n> serial device");
  }
  if (!options.bundle) throw new UsageError("--bundle is required");
  if (!options.manifest) throw new UsageError("--manifest is required");
  if (!Number.isFinite(options.ackTimeoutMs) || options.ackTimeoutMs <= 0) {
    throw new UsageError("--ack-timeout must be a positive number");
  }
  if (!Number.isFinite(options.commitTimeoutMs) || options.commitTimeoutMs <= 0) {
    throw new UsageError("--commit-timeout must be a positive number");
  }
  return { help: false, options };
}

async function run() {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`push-bundle: ${error.message}`);
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (parsed.help) {
    console.log(usage());
    return;
  }

  const { options } = parsed;
  const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
  const bytes = new Uint8Array(await readFile(options.bundle));
  const result = await runDevicePush(
    { manifest, bytes },
    options.port,
    undefined,
    { ackTimeoutMs: options.ackTimeoutMs, commitTimeoutMs: options.commitTimeoutMs },
  );
  console.log(`OK bundle=${result.bundleId} generation=${result.generation} epoch=${result.epoch}`);
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  run().catch((error) => {
    console.error(`push-bundle: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { parseCli, usage };
