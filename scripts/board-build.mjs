import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBoardProfile } from "./board-profile.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = resolveBoardProfile(process.env.TSX_LVGL_BOARD_PROFILE ?? "runtime-probe", repoRoot);
const projectPath = relative(repoRoot, profile.projectDirectory);
if (!projectPath || projectPath.startsWith("..")) throw new Error("board profile project must be inside this repository");

const result = spawnSync("./tools/dev", ["qemu", `cd ${projectPath} && idf.py build`], {
  cwd: repoRoot,
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
