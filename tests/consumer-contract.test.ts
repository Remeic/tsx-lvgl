import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("consumer contract works from a self-contained npm-pack artifact outside the workspace", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-consumer-contract-"));
  const packRoot = join(sandbox, "pack");
  const metadata = runJson(
    process.execPath,
    [join(repoRoot, "scripts/pack-sdk.mjs"), "--out", packRoot, "--json"],
    repoRoot,
  );
  const artifactPath = String(metadata.artifactPath);
  assert.ok(existsSync(artifactPath));

  const bootstrapRoot = join(sandbox, "bootstrap");
  mkdirSync(bootstrapRoot, { recursive: true });
  writeFileSync(
    join(sandbox, "bootstrap-package.json"),
    JSON.stringify({ name: "tsx-lvgl-contract-bootstrap", private: true, type: "module" }),
  );
  copyFileSync(join(sandbox, "bootstrap-package.json"), join(bootstrapRoot, "package.json"));
  run("npm", [
    "install",
    "--prefix",
    bootstrapRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    artifactPath,
  ], repoRoot);

  const cliPath = join(bootstrapRoot, "node_modules/@tsx-lvgl/sdk/dist/cli.js");
  const appRoot = join(sandbox, "tiltballs-like-app");
  const created = runJson(process.execPath, [cliPath, "create", appRoot, "--artifact", artifactPath, "--json"], sandbox);
  assert.equal(created.code, "CREATE_OK");
  const selfSeededRoot = join(sandbox, "self-seeded-app");
  const selfSeeded = runJson(process.execPath, [cliPath, "create", selfSeededRoot, "--json"], sandbox);
  assert.equal(selfSeeded.code, "CREATE_OK");

  const sync = runJson(process.execPath, [join(appRoot, "node_modules/@tsx-lvgl/sdk/dist/cli.js"), "sync", "--json"], appRoot);
  assert.equal(sync.code, "SYNC_OK");
  const update = runJson(process.execPath, [cliPath, "update", "--source", repoRoot, "--json"], appRoot);
  assert.equal(update.code, "UPDATE_OK");
  assert.equal(update.sourceSha, metadata.sourceSha);
  const check = runJson(process.execPath, [cliPath, "check", "--json"], appRoot);
  assert.equal(check.code, "CHECK_OK");
  assert.deepEqual(check.files, ["src/App.tsx"]);
  const build = runJson(process.execPath, [cliPath, "build", "--json"], appRoot);
  assert.equal(build.code, "BUILD_OK");
  assert.equal(typeof build.sha256, "string");
  const dev = runJson(process.execPath, [cliPath, "dev", "--json"], appRoot);
  assert.equal(dev.code, "DEV_OK");
  assert.deepEqual(dev.texts, ["Hello TSX-LVGL"]);
  const doctor = runJson(process.execPath, [cliPath, "doctor", "--json"], appRoot);
  assert.equal(doctor.code, "DOCTOR_OK");

  const packageJson = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    workspaces?: unknown;
  };
  assert.deepEqual(Object.keys(packageJson.dependencies), ["@tsx-lvgl/sdk"]);
  assert.equal(packageJson.workspaces, undefined);
  assert.equal(existsSync(join(appRoot, "node_modules/@tsx-lvgl/core")), false);

  const portableFiles = [
    "package.json",
    "package-lock.json",
    "tsx-lvgl.json",
    "tsconfig.json",
    ".tsx-lvgl/framework.lock.json",
    "AGENTS.md",
  ];
  for (const file of portableFiles) {
    const content = readFileSync(join(appRoot, file), "utf8");
    assert.equal(content.includes(repoRoot), false, `${file} must not contain the framework checkout path`);
    assert.equal(content.includes("packages/*/src"), false, `${file} must not contain a source alias`);
  }

  const lock = JSON.parse(readFileSync(join(appRoot, ".tsx-lvgl/framework.lock.json"), "utf8")) as {
    sourceSha: string;
    artifact: { file: string; sha256: string; byteLength: number };
  };
  const lockedArtifact = readFileSync(join(appRoot, lock.artifact.file));
  assert.match(lock.sourceSha, /^[0-9a-f]{40}$/);
  assert.equal(lock.artifact.byteLength, lockedArtifact.byteLength);
  assert.equal(lock.artifact.sha256, createHash("sha256").update(lockedArtifact).digest("hex"));
  assert.equal(basename(lock.artifact.file), "tsx-lvgl-sdk-0.1.0.tgz");
});

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function runJson(command: string, args: readonly string[], cwd: string): Record<string, any> {
  const stdout = run(command, args, cwd).trim();
  return JSON.parse(stdout) as Record<string, any>;
}
