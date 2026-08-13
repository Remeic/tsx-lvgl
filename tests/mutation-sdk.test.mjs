import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  DEFAULT_ARTIFACT_STORE,
  createArtifactStore,
  recoverProjectArtifactState,
  validateArtifactReference,
} from "../packages/sdk/dist/artifact-store.js";
import { InstallTransactionInterruptedError } from "../packages/sdk/dist/install-transaction.js";
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

  assert.throws(() => DEFAULT_ARTIFACT_STORE.install(root, sourceArtifact, metadata(sourceArtifact)), { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK });
  assert.equal(readFileSync(outsideArtifact, "utf8"), "keep this outside value");

  rmSync(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
  mkdirSync(join(root, ".tsx-lvgl", "artifacts"));
  symlinkSync(outsideArtifact, join(root, lock().artifact.file));
  assert.throws(() => DEFAULT_ARTIFACT_STORE.resolve(root, lock()), { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK });
  assert.throws(() => DEFAULT_ARTIFACT_STORE.verify(join(root, lock().artifact.file), lock()), { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK });
  assert.equal(readFileSync(outsideArtifact, "utf8"), "keep this outside value");
});

test("artifact-store reports an unavailable project root instead of guessing its layout", () => {
  assert.throws(
    () => DEFAULT_ARTIFACT_STORE.resolve("/tmp/tsx-lvgl-artifact-store-missing-root-xyz", lock()),
    { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK },
  );
});

test("artifact-store install recovers when the completed second rename is replaced by a link", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-post-rename-swap-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const outside = join(sandbox, "outside");
  const sourceArtifact = join(sandbox, "sdk.tgz");
  mkdirSync(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(sourceArtifact, "new artifact bytes");
  const initial = join(root, ".tsx-lvgl", "artifacts", "tsx-lvgl-sdk-0.1.0.tgz");
  writeFileSync(initial, "old artifact bytes");

  const store = createArtifactStore({
    afterSecondRename: () => {
      rmSync(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
      symlinkSync(outside, join(root, ".tsx-lvgl", "artifacts"), "dir");
    },
  });

  assert.throws(() => store.install(root, sourceArtifact, metadata(sourceArtifact)), { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK });
  assert.equal(existsSync(join(outside, "tsx-lvgl-sdk-0.1.0.tgz")), false);
  assert.equal(readFileSync(join(root, ".tsx-lvgl", "artifacts", "tsx-lvgl-sdk-0.1.0.tgz"), "utf8"), "old artifact bytes");
});

test("artifact-store install refuses to stage an existing artifacts directory containing a symlink", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-copy-entry-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const outside = join(sandbox, "outside");
  const sourceArtifact = join(sandbox, "sdk.tgz");
  mkdirSync(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(sourceArtifact, "new artifact bytes");
  writeFileSync(join(outside, "linked.tgz"), "outside value");
  symlinkSync(join(outside, "linked.tgz"), join(root, ".tsx-lvgl", "artifacts", "linked.tgz"));

  assert.throws(
    () => DEFAULT_ARTIFACT_STORE.install(root, sourceArtifact, metadata(sourceArtifact)),
    { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK },
  );
  assert.equal(readFileSync(join(outside, "linked.tgz"), "utf8"), "outside value");
});

test("artifact-store resolve rejects a symlinked artifacts directory without opening it", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-resolve-symlink-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const outside = join(sandbox, "outside");
  mkdirSync(join(root, ".tsx-lvgl"), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(root, ".tsx-lvgl", "artifacts"), "dir");

  assert.throws(() => DEFAULT_ARTIFACT_STORE.resolve(root, lock()), { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK });
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

  assert.throws(() => store.install(root, sourceArtifact, metadata(sourceArtifact)), { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK });
  assert.equal(readFileSync(outsideArtifact, "utf8"), "outside must survive");
  assert.equal(existsSync(join(root, ".tsx-lvgl", "artifacts")), true);
  assert.equal(existsSync(join(outside, "tsx-lvgl-sdk-0.1.0.tgz")), true);
});

test("artifact-store rejects a replaced project-state parent before any swap mutation", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-state-swap-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const outside = join(sandbox, "outside");
  const sourceArtifact = join(sandbox, "sdk.tgz");
  mkdirSync(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(sourceArtifact, "inside artifact");
  const store = createArtifactStore({
    beforeInstallSwap: () => {
      rmSync(join(root, ".tsx-lvgl"), { recursive: true, force: true });
      symlinkSync(outside, join(root, ".tsx-lvgl"), "dir");
    },
  });

  assert.throws(() => store.install(root, sourceArtifact, metadata(sourceArtifact)), { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK });
  assert.equal(existsSync(join(outside, "artifacts")), false);
});

test("artifact-store restart recovery completes both interrupted rename states idempotently", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-restart-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const sourceArtifact = join(sandbox, "sdk.tgz");
  writeFileSync(sourceArtifact, "new SDK artifact");

  for (const checkpoint of ["after-first-rename", "after-second-rename"]) {
    const root = join(sandbox, checkpoint);
    const initial = join(root, ".tsx-lvgl", "artifacts", "tsx-lvgl-sdk-0.1.0.tgz");
    mkdirSync(dirname(initial), { recursive: true });
    writeFileSync(initial, "old SDK artifact");
    const store = createArtifactStore({
      ...(checkpoint === "after-first-rename"
        ? { afterFirstRename: () => { throw new InstallTransactionInterruptedError(); } }
        : { afterSecondRename: () => { throw new InstallTransactionInterruptedError(); } }),
    });

    assert.throws(() => store.install(root, sourceArtifact, metadata(sourceArtifact)), InstallTransactionInterruptedError);
    recoverProjectArtifactState(root);
    recoverProjectArtifactState(root);
    assert.equal(
      readFileSync(join(root, ".tsx-lvgl", "artifacts", "tsx-lvgl-sdk-0.1.0.tgz"), "utf8"),
      checkpoint === "after-first-rename" ? "old SDK artifact" : "new SDK artifact",
    );
    assert.equal(existsSync(join(root, ".tsx-lvgl", ".artifacts-backup")), false);
    assert.equal(
      readdirSync(join(root, ".tsx-lvgl")).some((entry) => entry.startsWith(".artifacts-stage-")),
      false,
    );
  }
});

test("artifact recovery refuses a swapped state parent before rename or cleanup", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-recovery-swap-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const sourceArtifact = join(sandbox, "sdk.tgz");
  writeFileSync(sourceArtifact, "new SDK artifact");

  for (const checkpoint of ["after-first-rename", "after-second-rename"]) {
    const root = join(sandbox, checkpoint);
    const state = join(root, ".tsx-lvgl");
    const outside = join(sandbox, `${checkpoint}-outside`);
    const initial = join(state, "artifacts", "tsx-lvgl-sdk-0.1.0.tgz");
    mkdirSync(dirname(initial), { recursive: true });
    mkdirSync(outside);
    writeFileSync(initial, "old SDK artifact");
    writeFileSync(join(outside, "keep.txt"), "outside state");
    const store = createArtifactStore({
      ...(checkpoint === "after-first-rename"
        ? { afterFirstRename: () => { throw new InstallTransactionInterruptedError(); } }
        : { afterSecondRename: () => { throw new InstallTransactionInterruptedError(); } }),
    });
    assert.throws(() => store.install(root, sourceArtifact, metadata(sourceArtifact)), InstallTransactionInterruptedError);

    assert.throws(
      () => recoverProjectArtifactState(root, {
        beforeRecoveryMutation: () => {
          rmSync(state, { recursive: true, force: true });
          symlinkSync(outside, state, "dir");
        },
      }),
      { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK },
    );
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "outside state");
    assert.equal(existsSync(join(outside, "artifacts")), false);
  }
});

test("artifact recovery skips a stale stage-directory entry that is not a plain directory and prunes real ones via the hook", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-stage-prune-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const state = join(root, ".tsx-lvgl");
  mkdirSync(state, { recursive: true });
  const fakeStage = join(state, ".artifacts-stage-not-a-directory");
  writeFileSync(fakeStage, "leftover file, not a staged directory");
  const realStage = join(state, ".artifacts-stage-real");
  mkdirSync(realStage);

  const mutated = [];
  recoverProjectArtifactState(root, {
    beforeRecoveryMutation: (path) => mutated.push(path),
  });

  assert.equal(existsSync(fakeStage), true);
  assert.equal(existsSync(realStage), false);
  assert.deepEqual(mutated, [realStage]);
});

test("artifact-store reports an unavailable project root when it is a regular file", () => {
  const file = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-root-file-"));
  const rootAsFile = join(file, "not-a-directory");
  writeFileSync(rootAsFile, "not a directory");
  try {
    assert.throws(
      () => DEFAULT_ARTIFACT_STORE.resolve(rootAsFile, lock()),
      { code: DIAGNOSTIC_CODES.SOURCE_PATH_LEAK },
    );
  } finally {
    rmSync(file, { recursive: true, force: true });
  }
});

test("artifact-store install hooks fire for both rename checkpoints and restore after a failed second rename", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-artifact-second-rename-hooks-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const sourceArtifact = join(sandbox, "sdk.tgz");
  mkdirSync(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
  writeFileSync(sourceArtifact, "new artifact bytes");
  const initial = join(root, ".tsx-lvgl", "artifacts", "tsx-lvgl-sdk-0.1.0.tgz");
  writeFileSync(initial, "old artifact bytes");

  let beforeSecondRenameCalls = 0;
  let failSecondRenameCalls = 0;
  const failure = new Error("second rename hook failure");
  const store = createArtifactStore({
    beforeSecondRename: () => { beforeSecondRenameCalls += 1; },
    failSecondRename: () => {
      failSecondRenameCalls += 1;
      throw failure;
    },
  });

  assert.throws(() => store.install(root, sourceArtifact, metadata(sourceArtifact)), (error) => error === failure);
  assert.equal(beforeSecondRenameCalls, 1);
  assert.equal(failSecondRenameCalls, 1);
  assert.equal(readFileSync(join(root, ".tsx-lvgl", "artifacts", "tsx-lvgl-sdk-0.1.0.tgz"), "utf8"), "old artifact bytes");
  assert.equal(existsSync(join(root, ".tsx-lvgl", ".artifacts-backup")), false);
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
