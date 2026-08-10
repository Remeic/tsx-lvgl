import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import test from "node:test";

import { DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";
import {
  checkProject,
  createProject,
  devProject,
  doctorProject,
  packInstalledSdk,
  synchronizePackageLock,
  updateProject,
  verifyProject,
} from "../packages/sdk/dist/project.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim()
  || process.env.TSX_LVGL_VALIDATION_GIT_SHA;

function assertCode(action, code) {
  assert.throws(action, { code });
}

async function assertAsyncCode(action, code) {
  await assert.rejects(action, { code });
}

function packArtifact(sandbox) {
  const out = join(sandbox, "artifact");
  const result = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "pack-sdk.mjs"), "--out", out, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).artifactPath;
}

function writeSourceScript(source, output) {
  mkdirSync(join(source, "scripts"), { recursive: true });
  writeFileSync(join(source, "package.json"), '{"name":"fixture-source"}\n');
  writeFileSync(join(source, "scripts", "pack-sdk.mjs"), output);
}

function sourceMetadata(artifactPath) {
  return JSON.stringify({
    artifactPath,
    packageName: "@tsx-lvgl/sdk",
    version: "0.1.0",
    sourceSha: SHA,
    sourceDirty: false,
    sha256: "b".repeat(64),
    byteLength: 1,
  });
}

function archive(path, name, content, sizeText = undefined) {
  const header = Buffer.alloc(512);
  header.write(name);
  if (sizeText !== undefined) header.write(sizeText, 124);
  else header.write(Buffer.byteLength(content).toString(8).padStart(11, "0"), 124);
  const body = Buffer.from(content);
  writeFileSync(path, gzipSync(Buffer.concat([
    header,
    body,
    Buffer.alloc(Math.ceil(body.byteLength / 512) * 512 - body.byteLength),
    Buffer.alloc(1024),
  ])));
}

test("doctor keeps sequencing diagnostics when config or lock prerequisites fail", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-doctor-sequencing-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "app");
  await createProject(root, packArtifact(sandbox));

  const configPath = join(root, "tsx-lvgl.json");
  const lockPath = join(root, ".tsx-lvgl", "framework.lock.json");
  const config = readFileSync(configPath);
  const lock = readFileSync(lockPath);
  rmSync(configPath);
  const configFailure = doctorProject(root);
  assert.equal(configFailure.ok, false);
  assert.equal(configFailure.checks.find((check) => check.id === "ARTIFACT")?.diagnosticCode, DIAGNOSTIC_CODES.LOCK_INVALID);
  writeFileSync(configPath, config);
  rmSync(lockPath);
  const lockFailure = doctorProject(root);
  assert.equal(lockFailure.ok, false);
  assert.equal(lockFailure.checks.find((check) => check.id === "INSTALLATION")?.diagnosticCode, DIAGNOSTIC_CODES.LOCK_INVALID);
  writeFileSync(lockPath, lock);
});

test("consumer project validation reaches all portable persisted-state alternatives", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-project-state-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "app");
  await createProject(root, packArtifact(sandbox));
  const packagePath = join(root, "package.json");
  const configPath = join(root, "tsx-lvgl.json");
  const packageJson = readFileSync(packagePath);
  const config = readFileSync(configPath);

  writeFileSync(packagePath, '{"name":"app"}\n');
  assertCode(() => verifyProject(root), DIAGNOSTIC_CODES.PACKAGE_INVALID);
  writeFileSync(configPath, JSON.stringify({ version: 1, entry: join(root, "src", "App.tsx"), bundleId: "app" }));
  assertCode(() => verifyProject(root), DIAGNOSTIC_CODES.SOURCE_PATH_LEAK);
  writeFileSync(packagePath, packageJson);
  writeFileSync(configPath, config);

  const tsconfigPath = join(root, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath));
  const referenceRoot = join(root, "reference");
  mkdirSync(join(referenceRoot, "src"), { recursive: true });
  writeFileSync(join(referenceRoot, "src", "index.ts"), "export {};\n");
  writeFileSync(join(referenceRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: { composite: true, declaration: true, outDir: "dist" },
    include: ["src/**/*.ts"],
  }));
  tsconfig.references = [{ path: "./reference" }];
  writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig)}\n`);
  assert.deepEqual(checkProject(root).files, ["src/App.tsx"]);
});

test("update covers source configuration, artifact, dependency and temporary-directory boundaries", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-update-coverage-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "app");
  const artifact = packArtifact(sandbox);
  await createProject(root, artifact);
  const source = join(sandbox, "source");

  writeSourceScript(source, `process.stdout.write(${JSON.stringify(sourceMetadata(join(sandbox, "missing.tgz")))});\n`);
  await assertAsyncCode(() => updateProject(root, source), DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND);

  writeSourceScript(source, `process.stdout.write(${JSON.stringify(sourceMetadata(artifact))});\n`);
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath));
  delete packageJson.dependencies;
  writeFileSync(packagePath, `${JSON.stringify(packageJson)}\n`);
  await updateProject(root, source);
  assert.equal(typeof JSON.parse(readFileSync(packagePath)).dependencies["@tsx-lvgl/sdk"], "string");

  const previousTmpdir = process.env.TMPDIR;
  const previousConfig = process.env.TSX_LVGL_CONFIG;
  const previousHome = process.env.HOME;
  try {
    delete process.env.TMPDIR;
    writeSourceScript(source, "process.exitCode = 1;\n");
    await assertAsyncCode(() => updateProject(root, source), DIAGNOSTIC_CODES.SOURCE_PACK_FAILED);

    delete process.env.TSX_LVGL_CONFIG;
    process.env.HOME = join(sandbox, "home");
    await assertAsyncCode(() => updateProject(root), DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED);
    const machineConfig = join(process.env.HOME, ".config", "tsx-lvgl", "config.json");
    mkdirSync(dirname(machineConfig), { recursive: true });
    writeFileSync(machineConfig, "{}\n");
    await assertAsyncCode(() => updateProject(root), DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED);
    writeFileSync(machineConfig, JSON.stringify({ sourcePath: source }));
    await assertAsyncCode(() => updateProject(root), DIAGNOSTIC_CODES.SOURCE_PACK_FAILED);
    delete process.env.HOME;
    rmSync(machineConfig);
    await assertAsyncCode(() => updateProject(root), DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
    if (previousConfig === undefined) delete process.env.TSX_LVGL_CONFIG; else process.env.TSX_LVGL_CONFIG = previousConfig;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  }
});

test("dev, pack and archive parsing handle public error and fallback contracts", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-project-errors-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const previousTmpdir = process.env.TMPDIR;
  t.after(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  });
  const artifact = packArtifact(sandbox);
  const root = join(sandbox, "app");
  await createProject(root, artifact);
  const entryPath = join(root, "src", "App.tsx");
  const entry = readFileSync(entryPath);
  writeFileSync(entryPath, 'throw "primitive failure";\nexport default null as any;\n');
  await assertAsyncCode(() => devProject(root), DIAGNOSTIC_CODES.DEV_FAILED);
  writeFileSync(entryPath, entry);

  delete process.env.TMPDIR;
  const packed = packInstalledSdk("/sdk", {
    exists: () => true,
    makeTemporaryDirectory: () => join(sandbox, "packed"),
    remove: () => {},
    run: () => ({ status: 0, stdout: '[{"filename":"sdk.tgz"}]' }),
  });
  assert.equal(packed, join(sandbox, "packed", "sdk.tgz"));
  if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;

  const emptySizeArtifact = join(sandbox, "empty-size.tgz");
  archive(emptySizeArtifact, "package/other.json", "{}", "");
  await assertAsyncCode(() => createProject(join(sandbox, "empty-size"), emptySizeArtifact), DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH);
  const invalidProvenanceArtifact = join(sandbox, "invalid-provenance.tgz");
  archive(invalidProvenanceArtifact, "package/provenance.json", JSON.stringify({ formatVersion: 2 }));
  await assertAsyncCode(() => createProject(join(sandbox, "invalid-provenance"), invalidProvenanceArtifact), DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH);
});

test("package-manager and lock alternatives preserve the consumer boundary", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-package-manager-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const artifact = packArtifact(sandbox);
  const root = join(sandbox, "app");
  await createProject(root, artifact);
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath));
  packageJson.packageManager = "bun@1.2.0";
  writeFileSync(packagePath, `${JSON.stringify(packageJson)}\n`);
  const bin = join(sandbox, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nexec ${join(dirname(process.execPath), "npm")} install --ignore-scripts\n`);
  chmodSync(join(bin, "bun"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  const previousTmpdir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = sandbox;
    await updateProject(root, repositoryRoot);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
  }

  const lock = join(sandbox, "legacy.json");
  writeFileSync(lock, JSON.stringify({ dependencies: { "@tsx-lvgl/sdk": {} } }));
  synchronizePackageLock(lock, sandbox, artifact);
  assert.equal(existsSync(lock), true);
  writeFileSync(lock, JSON.stringify({ packages: { "": { dependencies: null }, "node_modules/@tsx-lvgl/sdk": {} } }));
  synchronizePackageLock(lock, sandbox, artifact);
  writeFileSync(lock, JSON.stringify({ dependencies: null }));
  assertCode(() => synchronizePackageLock(lock, sandbox, artifact), DIAGNOSTIC_CODES.INSTALL_FAILED);
});

test("scaffold fallback remains a valid portable package name", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-scaffold-name-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "---");
  const artifact = packArtifact(sandbox);
  await createProject(root, undefined, () => artifact);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"))).name, "tsx-lvgl-app");
  assert.equal(existsSync(dirname(artifact)), false);
});
