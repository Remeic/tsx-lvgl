import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSupportedBoardProfile, resolveBoardProfile } from "./board-profile.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseCli(argv) {
  let target;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--target" || argument.startsWith("--target=")) {
      if (target !== undefined) throw new Error("--target may be supplied only once");
      const inlineValue = argument.startsWith("--target=") ? argument.slice("--target=".length) : undefined;
      const value = inlineValue ?? argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--target requires a value");
      target = value;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (target === undefined) throw new Error("--target is required");
  return { help: false, target };
}

export function run(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  if (parsed.help) {
    console.log("Usage: node scripts/board-support-gate.mjs --target <target-key>");
    return 0;
  }
  const profile = resolveBoardProfile(parsed.target, repoRoot);
  assertSupportedBoardProfile(profile, "board reload");
  return 0;
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`board-support-gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
