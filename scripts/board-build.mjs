import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createArtifactDescriptor } from "./board-artifact-descriptor.mjs";
import { resolveBoardProfile } from "./board-profile.mjs";
import { generateBoardTargetIdHeader } from "./generate-board-target-id.mjs";
import { readFlagValue } from "./lib/cli.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40,64}$/;
/* Keep in sync with DEFAULT_KERNEL_OUT in scripts/build-kernel.mjs; that
 * module cannot be imported here without pulling bundler dependencies into
 * the firmware build environment. */
const CANONICAL_KERNEL_PATH = resolve(repoRoot, "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/main/kernel.js");

function usage() {
  return "Usage:\n  npm run board:build -- --target <target-key>\n\nA successful build also writes the target-bound artifact descriptor.\n";
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

/**
 * Targets embed one shared generated kernel. The canonical artifact lives in
 * the V1 reference target; every other target copies it at build time so a
 * committed twin cannot silently drift.
 */
function syncTargetKernel(profile) {
  const targetKernel = resolve(profile.projectDirectory, "main", "kernel.js");
  if (resolve(targetKernel) === resolve(CANONICAL_KERNEL_PATH)) return;
  if (!existsSync(CANONICAL_KERNEL_PATH)) throw new Error(`canonical kernel missing: run node scripts/build-kernel.mjs`);
  copyFileSync(CANONICAL_KERNEL_PATH, targetKernel);
}

export async function run(argv = process.argv.slice(2), runner = spawnSync) {  const parsed = parseCli(argv);
  if (parsed.help) {
    console.log(usage());
    return 0;
  }
  const profile = resolveBoardProfile(parsed.target, repoRoot);
  await generateBoardTargetIdHeader(profile);
  syncTargetKernel(profile);
  const projectPath = relative(repoRoot, profile.projectDirectory);
  if (!projectPath || projectPath.startsWith("..")) throw new Error("board target project must be inside this repository");
  const result = runner("./tools/dev", ["qemu", `cd ${projectPath} && idf.py build`], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if ((result.status ?? 1) !== 0) return result.status ?? 1;

  const sourceShaResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sourceSha = (sourceShaResult.stdout ?? "").trim();
  if (sourceShaResult.status !== 0 || !SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error(`cannot resolve source SHA: ${(sourceShaResult.stderr ?? "").trim() || "git failed"}`);
  }
  await createArtifactDescriptor({
    repositoryRoot: repoRoot,
    profile,
    sourceSha,
    artifactPath: profile.artifact,
    partitionTablePath: profile.partitionTableBinary,
    buildMetadataPath: profile.buildMetadataPath,
    outputPath: profile.descriptorPath,
  });
  console.log(`board-build: wrote ${profile.descriptorPath}`);
  return 0;
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  run().catch((error) => {
    console.error(`board-build: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 2;
  }).then((status) => {
    if (status !== undefined) process.exitCode = status;
  });
}

export { usage };
