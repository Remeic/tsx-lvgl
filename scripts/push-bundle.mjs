import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { ACK_TIMEOUT_MS, COMMIT_TIMEOUT_MS, createPushSession, parseDeviceLine } from "@tsx-lvgl/bundler";

import { readFlagValue } from "./lib/cli.mjs";

// Mirrors SERIAL_PORT_PATTERN in scripts/board-reload-plan.mjs (not exported there).
const SERIAL_PORT_PATTERN = /^\/dev\/(?:cu|tty)\.[A-Za-z0-9._-]+$/;

class UsageError extends Error {}

function usage() {
  return `Usage:
  node scripts/push-bundle.mjs --port /dev/cu.usbmodemXXX --bundle <path.js> --manifest <path.json> [options]

Options:
  --port PATH             Serial device, /dev/cu.* or /dev/tty.* (required).
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
    throw new UsageError("--port must be a /dev/cu.* or /dev/tty.* device");
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

function configurePort(port) {
  const result = spawnSync("stty", ["-f", port, "115200", "raw", "-echo"], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`stty configuration failed for ${port}: ${result.error ?? `exit ${result.status}`}`);
  }
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

  configurePort(options.port);

  const session = createPushSession(manifest, bytes);
  const output = createWriteStream(options.port);
  const input = createReadStream(options.port);
  const rl = createInterface({ input, crlfDelay: Infinity });

  let timer;
  let settled = false;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const armTimer = (state) => {
    clearTimer();
    if (state === "awaiting-rdy" || state === "sending") {
      timer = setTimeout(() => onEvent({ kind: "timeout" }), options.ackTimeoutMs);
    } else if (state === "awaiting-commit") {
      timer = setTimeout(() => onEvent({ kind: "timeout" }), options.commitTimeoutMs);
    }
  };

  const finish = (progress) => {
    if (settled) return;
    settled = true;
    clearTimer();
    rl.close();
    input.destroy();
    output.end();
    if (progress.state === "done" && progress.result) {
      console.log(`OK bundle=${manifest.bundleId} generation=${progress.result.generation} epoch=${progress.result.epoch}`);
      process.exitCode = 0;
    } else {
      console.error(`push-bundle: failed: ${progress.failure ?? "unknown"}`);
      process.exitCode = 1;
    }
  };

  const applyProgress = (progress) => {
    for (const frame of progress.send) {
      output.write(`${frame}\n`);
    }
    console.log(`chunk ${progress.acked}/${progress.total} acked (${progress.state})`);
    if (progress.state === "done" || progress.state === "failed") {
      finish(progress);
      return;
    }
    armTimer(progress.state);
  };

  function onEvent(event) {
    if (settled) return;
    applyProgress(session.handle(event));
  }

  rl.on("line", (rawLine) => {
    if (parseDeviceLine(rawLine).kind === "noise") {
      console.error(`device: ${rawLine}`);
    }
    onEvent({ kind: "line", line: rawLine });
  });

  applyProgress(session.begin());
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  run().catch((error) => {
    console.error(`push-bundle: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { parseCli, usage };
