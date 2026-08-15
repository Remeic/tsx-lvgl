import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceSha = "0123456789abcdef0123456789abcdef01234567";

test("registry SDK pack is public, self-contained, pack-clean, and installs its CLI", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-registry-pack-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const frameworkRoot = createFrameworkFixture(sandbox);
  const packed = runPack(sandbox, frameworkRoot, "clean");
  assert.equal(packed.distribution, "registry");
  assert.equal(packed.sourceSha, sourceSha);
  assert.equal(packed.sourceDirty, false);

  const extracted = join(sandbox, "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", packed.artifactPath, "-C", extracted]);
  const packageRoot = join(extracted, "package");
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.repository.url, "git+https://github.com/Remeic/tsx-lvgl.git");
  assert.equal(packageJson.bugs.url, "https://github.com/Remeic/tsx-lvgl/issues");
  assert.equal(packageJson.homepage, "https://github.com/Remeic/tsx-lvgl#readme");
  assert.deepEqual(packageJson.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
  assert.deepEqual(packageJson.dependencies, undefined);
  assert.deepEqual(packageJson.bundleDependencies, undefined);
  assert.equal(packageJson.bin["tsx-lvgl"], "dist/cli.js");
  assert.equal(existsSync(join(packageRoot, "provenance.json")), true);
  assert.deepEqual(JSON.parse(readFileSync(join(packageRoot, "provenance.json"), "utf8")), {
    formatVersion: 1,
    packageName: "@tsx-lvgl/sdk",
    version: "0.1.0",
    sourceSha,
    sourceDirty: false,
  });
  assert.equal(existsSync(join(packageRoot, "dist", "vendor", "runtime", "index.js")), true);
  assert.equal(existsSync(join(packageRoot, "dist", "tsconfig.tsbuildinfo")), false);

  const dryRun = spawnSync("npm", ["pack", "--dry-run", packed.artifactPath, "--ignore-scripts"], {
    cwd: sandbox,
    encoding: "utf8",
  });
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  assert.doesNotMatch(`${dryRun.stdout}\n${dryRun.stderr}`, /auto-corrected|Skipping workspace|script name .* invalid/i);

  const consumerRoot = join(sandbox, "consumer");
  writeFileSync(join(sandbox, "consumer-package.json"), JSON.stringify({ name: "registry-sdk-contract", private: true }));
  mkdirSync(consumerRoot);
  writeFileSync(join(consumerRoot, "package.json"), readFileSync(join(sandbox, "consumer-package.json")));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", packed.artifactPath], consumerRoot);
  const cli = join(consumerRoot, "node_modules", ".bin", "tsx-lvgl");
  assert.equal(existsSync(cli), true);
  const help = spawnSync(cli, ["--help"], { cwd: consumerRoot, encoding: "utf8" });
  assert.equal(help.status, 0, `${help.stdout}\n${help.stderr}`);
  assert.match(help.stdout, /tsx-lvgl create/);
});

test("registry SDK pack refuses a dirty source tree", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-registry-pack-dirty-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const result = runPackResult(sandbox, createFrameworkFixture(sandbox), "dirty");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registry packs require a clean source tree/);
});

test("registry SDK pack rebuilds generated output and excludes orphan files before staging", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-registry-pack-stale-"));
  const frameworkRoot = createFrameworkFixture(sandbox);
  const cliOutput = join(frameworkRoot, "packages", "sdk", "dist", "cli.js");
  const orphanOutput = join(frameworkRoot, "packages", "sdk", "dist", "registry-orphan.js");
  const original = readFileSync(cliOutput, "utf8");
  const staleMarker = "registry-pack-stale-output";
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  writeFileSync(cliOutput, `${original}\n// ${staleMarker}\n`, "utf8");
  writeFileSync(orphanOutput, "export const orphan = true;\n", "utf8");
  const packed = runPack(sandbox, frameworkRoot, "clean");

  const extracted = join(sandbox, "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", packed.artifactPath, "-C", extracted]);
  const packedCli = readFileSync(join(extracted, "package", "dist", "cli.js"), "utf8");
  assert.doesNotMatch(packedCli, new RegExp(staleMarker));
  assert.equal(existsSync(join(extracted, "package", "dist", "registry-orphan.js")), false);
});

function createFrameworkFixture(sandbox) {
  const frameworkRoot = join(sandbox, "framework");
  mkdirSync(frameworkRoot);
  cpSync(join(repositoryRoot, "tsconfig.base.json"), join(frameworkRoot, "tsconfig.base.json"));
  cpSync(join(repositoryRoot, "packages"), join(frameworkRoot, "packages"), { recursive: true });
  cpSync(join(repositoryRoot, "scripts"), join(frameworkRoot, "scripts"), { recursive: true });
  symlinkSync(join(repositoryRoot, "node_modules"), join(frameworkRoot, "node_modules"), "dir");
  return frameworkRoot;
}

function runPack(sandbox, frameworkRoot, gitState) {
  const result = runPackResult(sandbox, frameworkRoot, gitState);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runPackResult(sandbox, frameworkRoot, gitState) {
  const bin = join(sandbox, "bin");
  mkdirSync(bin);
  const git = join(bin, "git");
  writeFileSync(git, `#!/bin/sh
case "$*" in
  *"rev-parse HEAD"*) printf '%s\\n' '${sourceSha}' ;;
  *"status --porcelain"*) ${gitState === "dirty" ? "printf ' M package.json\\n'" : ":"} ;;
  *) exit 97 ;;
esac
`);
  chmodSync(git, 0o755);
  return spawnSync(process.execPath, [join(frameworkRoot, "scripts", "pack-sdk.mjs"), "--registry", "--out", join(sandbox, "artifacts"), "--json"], {
    cwd: frameworkRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
}
