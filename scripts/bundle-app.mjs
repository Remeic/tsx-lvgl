import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileTsxBundle } from "@tsx-lvgl/bundler";

import { readFlagValue } from "./lib/cli.mjs";

export function usage() {
  return `Usage:
  node scripts/bundle-app.mjs --entry <path.tsx> --out <dir> [options]

Options:
  --entry PATH        TSX entry file to compile (required).
  --out DIR           Output directory for the bundle and manifest (required).
  --bundle-id ID       Defaults to the entry file basename, lowercased.
  --generation N       Defaults to 1.
  --board-id ID        Explicit bundle compatibility target (required).
  --help                Show this help.
`;
}

export function parseCli(argv) {
  const options = {
    entry: "",
    out: "",
    bundleId: "",
    generation: 1,
    boardId: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      return { help: true };
    }

    const { name, value, nextIndex } = readFlagValue(argv, index);
    index = nextIndex;

    switch (name) {
      case "--entry":
        options.entry = value;
        break;
      case "--out":
        options.out = value;
        break;
      case "--bundle-id":
        options.bundleId = value;
        break;
      case "--generation":
        options.generation = Number(value);
        break;
      case "--board-id":
        options.boardId = value;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }

  if (!options.entry || !options.out) {
    throw new Error("--entry and --out are required");
  }
  if (!options.boardId) {
    throw new Error("--board-id is required");
  }
  if (!options.bundleId) {
    options.bundleId = basename(options.entry, extname(options.entry)).toLowerCase();
  }
  return { help: false, options };
}

export async function run() {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(`bundle-app: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exit(2);
  }

  if (parsed.help) {
    console.log(usage());
    return;
  }

  const { options } = parsed;
  const entryPath = resolve(options.entry);
  const outDir = resolve(options.out);

  let source;
  try {
    source = await readFile(entryPath, "utf8");
  } catch (error) {
    console.error(`bundle-app: cannot read entry: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  let output;
  try {
    output = compileTsxBundle({
      fileName: entryPath,
      source,
      bundleId: options.bundleId,
      boardId: options.boardId,
      generation: options.generation,
      jsxImportSource: "@tsx-lvgl/sdk",
    });
  } catch (error) {
    console.error(`bundle-app: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const codePath = resolve(outDir, `${options.bundleId}.g${options.generation}.js`);
  const manifestPath = resolve(outDir, `${options.bundleId}.g${options.generation}.manifest.json`);
  await writeFile(codePath, output.code);
  await writeFile(manifestPath, `${JSON.stringify(output.manifest, null, 2)}\n`);
  console.log(`bundle-app: wrote ${codePath}`);
  console.log(`bundle-app: wrote ${manifestPath}`);
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) run();
