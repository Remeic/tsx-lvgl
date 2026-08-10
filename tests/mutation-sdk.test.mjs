import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_ARTIFACT_STORE, createArtifactStore, validateArtifactReference } from "../packages/sdk/dist/artifact-store.js";
import { DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";
import { createInstallExecutor } from "../packages/sdk/dist/install-executor.js";
import { createProject, updateProject } from "../packages/sdk/dist/project.js";
import { parseSourcePackResult } from "../packages/sdk/dist/source-pack.js";

const sourceSha = "a".repeat(40);

function lock(version = "0.1.0") {
  return {
    formatVersion: 1,
    package: "@tsx-lvgl/sdk",
    version,
    sourceSha,
    artifact: {
      file: `.tsx-lvgl/artifacts/tsx-lvgl-sdk-${version}.tgz`,
      sha256: "b".repeat(64),
      byteLength: 1,
    },
  };
}

function metadata(artifactPath, version = "0.1.0") {
  return {
    artifactPath,
    packageName: "@tsx-lvgl/sdk",
    version,
    sourceSha,
    sourceDirty: false,
    sha256: "c".repeat(64),
    byteLength: 1,
  };
}

function installSnapshot(root, expectedLock) {
  const installedRoot = join(root, "node_modules", "@tsx-lvgl", "sdk");
  mkdirSync(installedRoot, { recursive: true });
  writeFileSync(join(installedRoot, "package.json"), JSON.stringify({
    name: "@tsx-lvgl/sdk",
    version: expectedLock.version,
  }));
  writeFileSync(join(installedRoot, "provenance.json"), JSON.stringify({
    packageName: "@tsx-lvgl/sdk",
    version: expectedLock.version,
    sourceSha: expectedLock.sourceSha,
    sourceDirty: false,
  }));
}

test("source-pack metadata stays strict without invoking a source checkout", () => {
  assert.deepEqual(
    parseSourcePackResult(`packing\n${JSON.stringify(metadata("/tmp/sdk.tgz"))}\n`),
    metadata("/tmp/sdk.tgz"),
  );
  assert.throws(
    () => parseSourcePackResult(JSON.stringify({ ...metadata("/tmp/sdk.tgz"), packageName: "wrong" })),
    { code: DIAGNOSTIC_CODES.SOURCE_PACK_FAILED },
  );
});

test("artifact-store records and verifies a local artifact without npm packing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tsx-lvgl-mutation-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceArtifact = join(root, "sdk.tgz");
  const bytes = Buffer.from("SDK artifact fixture");
  writeFileSync(sourceArtifact, bytes);

  const installed = DEFAULT_ARTIFACT_STORE.install(root, sourceArtifact, metadata(sourceArtifact));
  const installedPath = DEFAULT_ARTIFACT_STORE.resolve(root, installed);
  assert.equal(installed.artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(installed.artifact.byteLength, bytes.byteLength);
  assert.equal(existsSync(installedPath), true);
  DEFAULT_ARTIFACT_STORE.verify(installedPath, installed);
  const sameSizeCorruption = Buffer.alloc(bytes.byteLength, "x");
  writeFileSync(installedPath, sameSizeCorruption);
  assert.throws(
    () => DEFAULT_ARTIFACT_STORE.verify(installedPath, installed),
    { code: DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH },
  );
  const wrongSizeLock = {
    ...installed,
    artifact: {
      ...installed.artifact,
      sha256: createHash("sha256").update(sameSizeCorruption).digest("hex"),
      byteLength: sameSizeCorruption.byteLength + 1,
    },
  };
  assert.throws(
    () => DEFAULT_ARTIFACT_STORE.verify(installedPath, wrongSizeLock),
    { code: DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH },
  );
});

test("artifact-store rejects escaped lock paths and unsafe provenance versions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceArtifact = join(root, "sdk.tgz");
  writeFileSync(sourceArtifact, "SDK artifact fixture");

  const escapedLock = {
    ...lock(),
    artifact: { ...lock().artifact, file: ".tsx-lvgl/artifacts/../../../escaped.tgz" },
  };
  assert.throws(
    () => DEFAULT_ARTIFACT_STORE.resolve(root, escapedLock),
    { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK },
  );
  assert.throws(
    () => DEFAULT_ARTIFACT_STORE.install(root, sourceArtifact, metadata(sourceArtifact, "../../../escaped")),
    { code: DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH },
  );
  assert.equal(existsSync(join(root, "escaped.tgz")), false);
});

test("artifact-store refuses artifact-directory and final-file symlink escapes without touching the target", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-symlink-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const outside = join(sandbox, "outside");
  const sourceArtifact = join(sandbox, "sdk.tgz");
  mkdirSync(join(root, ".tsx-lvgl"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(sourceArtifact, "new SDK artifact");
  const outsideArtifact = join(outside, "tsx-lvgl-sdk-0.1.0.tgz");
  writeFileSync(outsideArtifact, "keep this outside value");
  symlinkSync(outside, join(root, ".tsx-lvgl", "artifacts"), "dir");

  const installed = DEFAULT_ARTIFACT_STORE.install(root, sourceArtifact, metadata(sourceArtifact));
  assert.equal(readFileSync(outsideArtifact, "utf8"), "keep this outside value");
  assert.equal(readFileSync(DEFAULT_ARTIFACT_STORE.resolve(root, installed), "utf8"), "new SDK artifact");

  rmSync(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
  mkdirSync(join(root, ".tsx-lvgl", "artifacts"));
  symlinkSync(outsideArtifact, join(root, lock().artifact.file));
  assert.throws(() => DEFAULT_ARTIFACT_STORE.resolve(root, lock()), { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK });
  assert.throws(() => DEFAULT_ARTIFACT_STORE.verify(join(root, lock().artifact.file), lock()), { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK });
  assert.equal(readFileSync(outsideArtifact, "utf8"), "keep this outside value");
});

test("artifact-store stage swap cannot be redirected when artifacts is replaced after validation", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-swap-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const outside = join(sandbox, "outside");
  const sourceArtifact = join(sandbox, "sdk.tgz");
  mkdirSync(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(sourceArtifact, "inside artifact");
  const outsideArtifact = join(outside, "tsx-lvgl-sdk-0.1.0.tgz");
  writeFileSync(outsideArtifact, "outside must survive");
  const store = createArtifactStore({
    beforeInstallSwap: () => {
      rmSync(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
      symlinkSync(outside, join(root, ".tsx-lvgl", "artifacts"), "dir");
    },
  });

  const installed = store.install(root, sourceArtifact, metadata(sourceArtifact));
  assert.equal(readFileSync(outsideArtifact, "utf8"), "outside must survive");
  assert.equal(readFileSync(store.resolve(root, installed), "utf8"), "inside artifact");
  assert.equal(existsSync(join(outside, "tsx-lvgl-sdk-0.1.0.tgz")), true);
});

test("artifact references reject every non-canonical persisted path shape", () => {
  for (const file of [
    "/tmp/sdk.tgz",
    ".tsx-lvgl\\artifacts\\sdk.tgz",
    "artifacts/sdk.tgz",
    ".tsx-lvgl/artifacts/",
    ".tsx-lvgl/artifacts/../sdk.tgz",
  ]) {
    assert.throws(() => validateArtifactReference(file), { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK });
  }
});

test("project lifecycle uses injected source, artifact and install boundaries in-process", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tsx-lvgl-mutation-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let removedOutput;
  let sourceDirty = false;
  const adapters = {
    artifactStore: {
      resolve: (projectRoot, installedLock) => join(projectRoot, installedLock.artifact.file),
      verify: () => {},
      install: (projectRoot, artifactPath, packMetadata) => {
        calls.push(["artifact", artifactPath, packMetadata?.version]);
        return lock(packMetadata?.version);
      },
    },
    installExecutor: {
      install: async (projectRoot, installedLock, artifactPath, verifyInstalled) => {
        calls.push(["install", artifactPath]);
        mkdirSync(join(projectRoot, ".tsx-lvgl"), { recursive: true });
        writeFileSync(join(projectRoot, ".tsx-lvgl", "framework.lock.json"), JSON.stringify(installedLock));
        installSnapshot(projectRoot, installedLock);
        verifyInstalled();
      },
    },
    sourcePackAdapter: {
      resolveSource: (explicitSource) => {
        calls.push(["source", explicitSource]);
        return "/fixture/source";
      },
      createOutputDirectory: () => "/fixture/output",
      pack: (sourceRoot, outputRoot) => {
        calls.push(["pack", sourceRoot, outputRoot]);
        return { ...metadata("/fixture/sdk-0.2.0.tgz", "0.2.0"), sourceDirty };
      },
      removeOutputDirectory: (outputRoot) => { removedOutput = outputRoot; },
    },
  };

  const created = await createProject(join(root, "Project Name"), "/fixture/sdk-0.1.0.tgz", undefined, adapters);
  assert.equal(created.lock.version, "0.1.0");
  assert.equal(JSON.parse(readFileSync(join(created.root, "package.json"), "utf8")).name, "project-name");

  const updated = await updateProject(created.root, "/fixture/source", adapters);
  assert.equal(updated.lock.version, "0.2.0");
  assert.equal(removedOutput, "/fixture/output");
  sourceDirty = true;
  await assert.rejects(
    updateProject(created.root, "/fixture/dirty-source", adapters),
    { code: DIAGNOSTIC_CODES.SOURCE_DIRTY },
  );
  assert.deepEqual(calls, [
    ["artifact", "/fixture/sdk-0.1.0.tgz", undefined],
    ["install", join(created.root, lock().artifact.file)],
    ["source", "/fixture/source"],
    ["pack", "/fixture/source", "/fixture/output"],
    ["artifact", "/fixture/sdk-0.2.0.tgz", "0.2.0"],
    ["install", join(created.root, lock("0.2.0").artifact.file)],
    ["source", "/fixture/dirty-source"],
    ["pack", "/fixture/source", "/fixture/output"],
  ]);
});

test("update rejects a non-consumer target before resolving or packing source", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tsx-lvgl-update-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const adapters = {
    artifactStore: DEFAULT_ARTIFACT_STORE,
    installExecutor: { install: async () => { throw new Error("unreachable"); } },
    sourcePackAdapter: {
      resolveSource: () => { calls.push("source"); return "/fixture/source"; },
      createOutputDirectory: () => { calls.push("output"); return "/fixture/output"; },
      pack: () => { calls.push("pack"); throw new Error("unreachable"); },
      removeOutputDirectory: () => { calls.push("remove"); },
    },
  };

  await assert.rejects(updateProject(root, "/fixture/source", adapters), { code: DIAGNOSTIC_CODES.CONFIG_NOT_FOUND });
  assert.deepEqual(calls, []);
});

test("install executor writes the SDK pin before its injected package-manager boundary", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tsx-lvgl-mutation-installer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{"name":"fixture","dependencies":{"keep":"1"}}\n');
  mkdirSync(join(root, ".tsx-lvgl"));
  const installedLock = lock();
  let packageManagerCall;
  let verified = 0;
  const executor = createInstallExecutor(async (projectRoot, artifactPath) => {
    packageManagerCall = [projectRoot, artifactPath];
  });

  await executor.install(root, installedLock, "/fixture/sdk.tgz", () => { verified += 1; });

  assert.deepEqual(packageManagerCall, [root, "/fixture/sdk.tgz"]);
  assert.equal(verified, 1);
  const dependencies = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies;
  assert.equal(dependencies.keep, "1");
  assert.equal(dependencies["@tsx-lvgl/sdk"], `file:${installedLock.artifact.file}`);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".tsx-lvgl", "framework.lock.json"), "utf8")), installedLock);
});
