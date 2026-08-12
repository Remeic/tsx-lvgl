import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BOARD_ID, compileTsxBundle } from "@tsx-lvgl/bundler";

import { resolveBoardProfile } from "./board-profile.mjs";
import { readFlagValue } from "./lib/cli.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultProfile = "runtime-probe";
const defaultEntry = resolve(repoRoot, "examples/apps/pomodoro.tsx");
const examplesDirectory = resolve(repoRoot, "examples/apps");

function usage() {
  return `Usage:
  node scripts/embed-runtime-app.mjs [options]

Options:
  --entry PATH        TSX entry to embed; defaults to examples/apps/pomodoro.tsx.
  --app NAME           Shorthand for examples/apps/NAME.tsx.
  --bundle-id ID      Bundle identity; defaults to the entry basename.
  --profile NAME      Board profile; default runtime-probe.
  --help              Show this help.

The generated files always use the stable app.g1.* names expected by the
runtime probe. The manifest keeps the selected bundle identity.
`;
}

function defaultBundleId(entry) {
  return basename(entry, extname(entry)).toLowerCase();
}

export function parseCli(argv) {
  const options = {
    entry: defaultEntry,
    bundleId: "",
    profile: defaultProfile,
  };
  let entrySpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };

    const { name, value, nextIndex } = readFlagValue(argv, index);
    index = nextIndex;
    switch (name) {
      case "--entry":
        if (entrySpecified) throw new Error("--entry and --app are mutually exclusive");
        options.entry = resolve(value);
        entrySpecified = true;
        break;
      case "--app":
        if (entrySpecified) throw new Error("--entry and --app are mutually exclusive");
        if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("--app must be a simple app name");
        options.entry = resolve(examplesDirectory, `${value}.tsx`);
        entrySpecified = true;
        break;
      case "--bundle-id":
        options.bundleId = value;
        break;
      case "--profile":
        options.profile = value;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }

  if (!options.bundleId) options.bundleId = defaultBundleId(options.entry);
  return { help: false, options };
}

export async function embedRuntimeApp({ entry, bundleId, profile = defaultProfile, repoRoot: root = repoRoot }) {
  const board = resolveBoardProfile(profile, root);
  const entryPath = resolve(entry);
  const source = await readFile(entryPath, "utf8");
  const output = compileTsxBundle({
    fileName: entryPath,
    source,
    bundleId: bundleId || defaultBundleId(entryPath),
    boardId: BOARD_ID,
    generation: 1,
    jsxImportSource: "@tsx-lvgl/sdk",
  });

  await mkdir(board.embeddedAppDirectory, { recursive: true });
  await writeFile(board.embeddedAppCodePath, output.code);
  await writeFile(board.embeddedAppManifestPath, `${JSON.stringify(output.manifest, null, 2)}\n`);
  return {
    ...output,
    entryPath,
    codePath: board.embeddedAppCodePath,
    manifestPath: board.embeddedAppManifestPath,
  };
}

async function run() {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(`embed-runtime-app: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (parsed.help) {
    console.log(usage());
    return;
  }

  try {
    const result = await embedRuntimeApp(parsed.options);
    console.log(`embed-runtime-app: ${result.manifest.bundleId} generation=${result.manifest.generation}`);
    console.log(`embed-runtime-app: wrote ${result.codePath}`);
    console.log(`embed-runtime-app: wrote ${result.manifestPath}`);
  } catch (error) {
    console.error(`embed-runtime-app: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) await run();

export { defaultEntry, defaultProfile, usage };
