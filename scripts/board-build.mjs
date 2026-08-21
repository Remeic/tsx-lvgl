import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBoardProfile } from "./board-profile.mjs";
import { readFlagValue } from "./lib/cli.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return "Usage:\n  npm run board:build -- --target <target-key>\n";
}

export function parseCli(argv) {
  let target;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    const parsed = readFlagValue(argv, index);
    index = parsed.nextIndex;
    if (parsed.name !== "--target") throw new Error(`unknown option: ${argument}`);
    if (target !== undefined) throw new Error("--target may be supplied only once");
    target = parsed.value;
  }
  if (target === undefined) throw new Error("--target is required");
  return { help: false, target };
}

export function run(argv = process.argv.slice(2), runner = spawnSync) {
  const parsed = parseCli(argv);
  if (parsed.help) {
    console.log(usage());
    return 0;
  }
  const profile = resolveBoardProfile(parsed.target, repoRoot);
  const projectPath = relative(repoRoot, profile.projectDirectory);
  if (!projectPath || projectPath.startsWith("..")) throw new Error("board target project must be inside this repository");
  const result = runner("./tools/dev", ["qemu", `cd ${projectPath} && idf.py build`], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`board-build: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 2;
  }
}

export { usage };
