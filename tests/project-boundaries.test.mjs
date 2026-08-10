import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import test from "node:test";

import { DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";
import {
  buildProject,
  checkProject,
  createProject,
  devProject,
  readProjectFiles,
  syncProject,
  updateProject,
  verifyProject,
} from "../packages/sdk/dist/project.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function assertCode(action, code) {
  assert.throws(action, { code });
}

function provenanceArchive(path, provenance) {
  const content = Buffer.from(JSON.stringify(provenance));
  const header = Buffer.alloc(512);
  header.write("package/provenance.json");
  header.write(content.byteLength.toString(8).padStart(11, "0"), 124);
  writeFileSync(path, gzipSync(Buffer.concat([header, content, Buffer.alloc(Math.ceil(content.byteLength / 512) * 512 - content.byteLength), Buffer.alloc(1024)])));
}

async function assertAsyncCode(action, code) {
  await assert.rejects(action, { code });
}

test("project facade rejects invalid persisted boundaries before lifecycle work", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-project-boundaries-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const artifactRoot = join(sandbox, "artifact");
  const packed = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "pack-sdk.mjs"), "--out", artifactRoot, "--json"], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const root = join(sandbox, "app");
  await assertAsyncCode(() => createProject(join(sandbox, "no-artifact")), DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND);
  const malformedArtifact = join(sandbox, "malformed.tgz");
  writeFileSync(malformedArtifact, "not a gzip archive");
  await assertAsyncCode(() => createProject(join(sandbox, "malformed"), malformedArtifact), DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH);
  const dirtyArtifact = join(sandbox, "dirty.tgz");
  provenanceArchive(dirtyArtifact, { formatVersion: 1, packageName: "@tsx-lvgl/sdk", version: "0.1.0", sourceSha: "a".repeat(40), sourceDirty: true });
  await assertAsyncCode(() => createProject(join(sandbox, "dirty"), dirtyArtifact), DIAGNOSTIC_CODES.SOURCE_DIRTY);
  await createProject(root, JSON.parse(packed.stdout).artifactPath);

  const configPath = join(root, "tsx-lvgl.json");
  const lockPath = join(root, ".tsx-lvgl", "framework.lock.json");
  const packagePath = join(root, "package.json");
  const tsconfigPath = join(root, "tsconfig.json");
  const entryPath = join(root, "src", "App.tsx");
  const config = readFileSync(configPath);
  const lock = readFileSync(lockPath);
  const consumerPackage = readFileSync(packagePath);
  const tsconfig = readFileSync(tsconfigPath);
  const entry = readFileSync(entryPath);
  const project = readProjectFiles(root);
  const artifact = readFileSync(project.artifactPath);
  const installed = join(root, "node_modules", "@tsx-lvgl", "sdk");
  const installedSnapshot = join(sandbox, "installed-sdk");
  cpSync(installed, installedSnapshot, { recursive: true });

  await assertAsyncCode(() => createProject(root, JSON.parse(packed.stdout).artifactPath), DIAGNOSTIC_CODES.PROJECT_EXISTS);
  rmSync(configPath);
  assertCode(() => readProjectFiles(root), DIAGNOSTIC_CODES.CONFIG_NOT_FOUND);
  writeFileSync(configPath, '{"version":2}\n');
  assertCode(() => readProjectFiles(root), DIAGNOSTIC_CODES.CONFIG_INVALID);
  writeFileSync(configPath, '{ not json');
  assertCode(() => readProjectFiles(root), DIAGNOSTIC_CODES.CONFIG_INVALID);
  writeFileSync(configPath, '{"version":1,"entry":"src/App.tsx","bundleId":"bad space","generation":0}\n');
  assertCode(() => readProjectFiles(root), DIAGNOSTIC_CODES.CONFIG_INVALID);
  writeFileSync(configPath, '{"version":1,"entry":"src/App.tsx","bundleId":"bad space"}\n');
  assertCode(() => readProjectFiles(root), DIAGNOSTIC_CODES.CONFIG_INVALID);
  writeFileSync(configPath, '{"version":1,"entry":"../outside.tsx","bundleId":"app"}\n');
  assertCode(() => readProjectFiles(root), DIAGNOSTIC_CODES.SOURCE_PATH_LEAK);
  writeFileSync(configPath, '{"version":1,"entry":"src/missing.tsx","bundleId":"app"}\n');
  assertCode(() => readProjectFiles(root), DIAGNOSTIC_CODES.CONFIG_INVALID);
  writeFileSync(configPath, config);

  rmSync(lockPath);
  assertCode(() => readProjectFiles(root), DIAGNOSTIC_CODES.LOCK_NOT_FOUND);
  writeFileSync(lockPath, '{"formatVersion":1}\n');
  assertCode(() => readProjectFiles(root), DIAGNOSTIC_CODES.LOCK_INVALID);
  const escapedLock = JSON.parse(lock);
  escapedLock.artifact.file = "../escaped.tgz";
  writeFileSync(lockPath, `${JSON.stringify(escapedLock)}\n`);
  assertCode(() => readProjectFiles(root), DIAGNOSTIC_CODES.SOURCE_PATH_LEAK);
  writeFileSync(lockPath, lock);

  rmSync(project.artifactPath);
  assertCode(() => verifyProject(root), DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND);
  writeFileSync(project.artifactPath, Buffer.from("corrupt"));
  assertCode(() => verifyProject(root), DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH);
  writeFileSync(project.artifactPath, artifact);
  const invalidDependency = JSON.parse(consumerPackage);
  invalidDependency.dependencies["@tsx-lvgl/sdk"] = "workspace:*";
  writeFileSync(packagePath, `${JSON.stringify(invalidDependency)}\n`);
  assertCode(() => verifyProject(root), DIAGNOSTIC_CODES.PACKAGE_INVALID);
  const leakingPackage = JSON.parse(consumerPackage);
  leakingPackage.workspaces = ["packages/*"];
  writeFileSync(packagePath, `${JSON.stringify(leakingPackage)}\n`);
  assertCode(() => verifyProject(root), DIAGNOSTIC_CODES.SOURCE_PATH_LEAK);
  writeFileSync(packagePath, consumerPackage);
  rmSync(installed, { recursive: true });
  assertCode(() => verifyProject(root), DIAGNOSTIC_CODES.PACKAGE_NOT_INSTALLED);
  mkdirSync(dirname(installed), { recursive: true });
  cpSync(installedSnapshot, installed, { recursive: true });
  const installedPackagePath = join(installed, "package.json");
  const installedPackage = readFileSync(installedPackagePath);
  writeFileSync(installedPackagePath, '{"name":"wrong","version":"0.1.0"}\n');
  assertCode(() => verifyProject(root), DIAGNOSTIC_CODES.PACKAGE_NOT_INSTALLED);
  writeFileSync(installedPackagePath, installedPackage);
  const provenancePath = join(installed, "provenance.json");
  const provenance = JSON.parse(readFileSync(provenancePath));
  provenance.sourceDirty = true;
  writeFileSync(provenancePath, `${JSON.stringify(provenance)}\n`);
  assertCode(() => verifyProject(root), DIAGNOSTIC_CODES.PACKAGE_NOT_INSTALLED);
  cpSync(installedSnapshot, installed, { recursive: true, force: true });
  writeFileSync(tsconfigPath, '{ invalid json');
  assertCode(() => checkProject(root), DIAGNOSTIC_CODES.TYPECHECK_FAILED);
  rmSync(tsconfigPath);
  assertCode(() => checkProject(root), DIAGNOSTIC_CODES.CONFIG_NOT_FOUND);
  writeFileSync(tsconfigPath, tsconfig);
  writeFileSync(tsconfigPath, `${tsconfig}\n// paths\n`);
  assertCode(() => verifyProject(root), DIAGNOSTIC_CODES.SOURCE_PATH_LEAK);
  writeFileSync(tsconfigPath, tsconfig);
  writeFileSync(entryPath, "export default 42 as any;\n");
  await assertAsyncCode(() => devProject(root), DIAGNOSTIC_CODES.DEV_FAILED);
  writeFileSync(entryPath, entry);
  const originalPath = process.env.PATH;
  const fakeBin = join(sandbox, "fake-bin");
  mkdirSync(fakeBin);
  const fakeNpm = join(fakeBin, "npm");
  writeFileSync(fakeNpm, "#!/bin/sh\nexit 7\n");
  chmodSync(fakeNpm, 0o755);
  const managerPackage = JSON.parse(consumerPackage);
  managerPackage.packageManager = "npm@11.0.0";
  writeFileSync(packagePath, `${JSON.stringify(managerPackage)}\n`);
  process.env.PATH = fakeBin;
  await assertAsyncCode(() => syncProject(root), DIAGNOSTIC_CODES.INSTALL_FAILED);
  process.env.PATH = "";
  await assertAsyncCode(() => syncProject(root), DIAGNOSTIC_CODES.PACKAGE_MANAGER_NOT_FOUND);
  process.env.PATH = originalPath;
  writeFileSync(packagePath, consumerPackage);
  assert.equal((await syncProject(root)).lock.sourceSha.length, 40);
});

test("update source boundary fails closed for missing, invalid, malformed and dirty pack metadata", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-update-boundaries-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "app");
  const artifactRoot = join(sandbox, "artifact");
  const packed = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "pack-sdk.mjs"), "--out", artifactRoot, "--json"], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  await createProject(root, JSON.parse(packed.stdout).artifactPath);
  await assertAsyncCode(() => updateProject(root, ""), DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED);
  await assertAsyncCode(() => updateProject(root, join(sandbox, "missing")), DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED);
  const source = join(sandbox, "source");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "package.json"), '{"name":"source"}\n');
  await assertAsyncCode(() => updateProject(root, source), DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED);
  mkdirSync(join(source, "scripts"), { recursive: true });
  const script = join(source, "scripts", "pack-sdk.mjs");
  writeFileSync(script, "process.exitCode = 1;\n");
  await assertAsyncCode(() => updateProject(root, source), DIAGNOSTIC_CODES.SOURCE_PACK_FAILED);
  writeFileSync(script, "process.stdout.write('not json\\n');\n");
  await assertAsyncCode(() => updateProject(root, source), DIAGNOSTIC_CODES.SOURCE_PACK_FAILED);
  writeFileSync(script, "process.stdout.write('');\n");
  await assertAsyncCode(() => updateProject(root, source), DIAGNOSTIC_CODES.SOURCE_PACK_FAILED);
  writeFileSync(script, "process.stdout.write('{}');\n");
  await assertAsyncCode(() => updateProject(root, source), DIAGNOSTIC_CODES.SOURCE_PACK_FAILED);
  writeFileSync(script, `process.stdout.write(JSON.stringify({ artifactPath: "x", packageName: "@tsx-lvgl/sdk", version: "0.1.0", sourceSha: "${"a".repeat(40)}", sourceDirty: true, sha256: "${"a".repeat(64)}", byteLength: 1 }));\n`);
  await assertAsyncCode(() => updateProject(root, source), DIAGNOSTIC_CODES.SOURCE_DIRTY);
  const packedArtifact = JSON.parse(packed.stdout).artifactPath;
  writeFileSync(script, `process.stdout.write(JSON.stringify({ artifactPath: ${JSON.stringify(packedArtifact)}, packageName: "@tsx-lvgl/sdk", version: "0.1.0", sourceSha: "not-a-sha", sourceDirty: false, sha256: "${"a".repeat(64)}", byteLength: 1 }));\n`);
  await assertAsyncCode(() => updateProject(root, source), DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH);
  const originalSource = process.env.TSX_LVGL_SOURCE;
  const originalConfig = process.env.TSX_LVGL_CONFIG;
  const machineConfig = join(sandbox, "machine-config.json");
  writeFileSync(machineConfig, JSON.stringify({ sourcePath: source }));
  delete process.env.TSX_LVGL_SOURCE;
  process.env.TSX_LVGL_CONFIG = machineConfig;
  await assertAsyncCode(() => updateProject(root), DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH);
  writeFileSync(machineConfig, "not json");
  await assertAsyncCode(() => updateProject(root), DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED);
  if (originalSource === undefined) delete process.env.TSX_LVGL_SOURCE; else process.env.TSX_LVGL_SOURCE = originalSource;
  if (originalConfig === undefined) delete process.env.TSX_LVGL_CONFIG; else process.env.TSX_LVGL_CONFIG = originalConfig;
  assert.equal(existsSync(join(root, ".tsx-lvgl", "framework.lock.json")), true);
});
