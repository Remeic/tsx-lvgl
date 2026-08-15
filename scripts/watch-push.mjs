import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BOARD_ID, compileTsxBundle } from "@tsx-lvgl/bundler";
import { runDevicePush } from "../packages/sdk/dist/device-dev.js";
import { runDeviceWatch } from "../packages/sdk/dist/device-watch.js";

import { readFlagValue } from "./lib/cli.mjs";

const SERIAL_PORT_PATTERN = /^(?:\/dev\/(?:cu|tty)\.[A-Za-z0-9._-]+|COM[1-9][0-9]*)$/i;

class UsageError extends Error {}

function usage() {
  return `Usage:
  tools/watch-push --entry <path.tsx> --port /dev/cu.usbmodemXXX [options]

Options:
  --entry PATH        TSX entry watched for changes (required).
  --port PATH         Local serial device (required).
  --bundle-id ID      Defaults to the entry file basename, lowercased.
  --generation N      Initial generation; defaults to 1 and is negotiated.
  --board-id ID       Defaults to ${BOARD_ID}.
  --help              Show this help.
`;
}

function parseCli(argv) {
  const options = { entry: "", port: "", bundleId: "", generation: 1, boardId: BOARD_ID };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true, options };
    let parsed;
    try {
      parsed = readFlagValue(argv, index);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    index = parsed.nextIndex;
    switch (parsed.name) {
      case "--entry": options.entry = parsed.value; break;
      case "--port": options.port = parsed.value; break;
      case "--bundle-id": options.bundleId = parsed.value; break;
      case "--generation": options.generation = Number(parsed.value); break;
      case "--board-id": options.boardId = parsed.value; break;
      default: throw new UsageError(`unknown option: ${argument}`);
    }
  }
  if (!options.entry) throw new UsageError("--entry is required");
  if (!SERIAL_PORT_PATTERN.test(options.port)) {
    throw new UsageError("--port must be a local /dev/cu.*, /dev/tty.* or COM<n> serial device");
  }
  if (!Number.isSafeInteger(options.generation) || options.generation <= 0) {
    throw new UsageError("--generation must be a positive safe integer");
  }
  if (!options.bundleId) options.bundleId = basename(options.entry, extname(options.entry)).toLowerCase();
  return { help: false, options };
}

async function run(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    console.error(`watch-push: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    console.log(usage());
    return;
  }

  const entryPath = resolve(parsed.options.entry);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`WATCH entry=${entryPath} port=${parsed.options.port}`);
  try {
    await runDeviceWatch({
      initialGeneration: parsed.options.generation,
      signal: controller.signal,
      watch: (onChange, onError) => {
        const entryName = basename(entryPath);
        const watcher = watch(dirname(entryPath), (_event, fileName) => {
          if (fileName === null || String(fileName) === entryName) onChange();
        });
        watcher.on("error", onError);
        return watcher;
      },
      build: async (generation) => compileTsxBundle({
        fileName: entryPath,
        source: await readFile(entryPath, "utf8"),
        bundleId: parsed.options.bundleId,
        boardId: parsed.options.boardId,
        generation,
        jsxImportSource: "@tsx-lvgl/sdk",
      }),
      push: (bundle) => runDevicePush(bundle, parsed.options.port),
      onAccepted: (result) => console.log(`OK bundle=${result.bundleId} generation=${result.generation} epoch=${result.epoch}`),
      onRejected: (error) => console.error(`REJECTED ${error.message}`),
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) run().catch((error) => {
  console.error(`watch-push: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

export { parseCli, run, usage };
