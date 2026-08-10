import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { withInstallTransaction } from "../packages/sdk/dist/install-transaction.js";

test("failed install restores all prior dependency and metadata state atomically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-transaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "package.json");
  const lockPath = join(root, "pnpm-lock.yaml");
  const artifactPath = join(root, ".tsx-lvgl", "artifacts", "sdk.tgz");
  const unrelatedDependency = join(root, "node_modules", "unrelated", "marker.txt");
  const originalPackage = '{"dependencies":{"unrelated":"1.0.0"}}\n';
  const originalLock = "lockfileVersion: '9.0'\n";
  await Promise.all([
    mkdir(join(root, "node_modules", "unrelated"), { recursive: true }),
    mkdir(join(root, ".tsx-lvgl", "artifacts"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(packagePath, originalPackage),
    writeFile(lockPath, originalLock),
    writeFile(unrelatedDependency, "preserve me\n"),
    writeFile(artifactPath, "old artifact bytes\n"),
  ]);

  await assert.rejects(
    withInstallTransaction(root, async () => {
      await mkdir(join(root, "node_modules", "new-dependency"), { recursive: true });
      await mkdir(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
      await Promise.all([
        writeFile(packagePath, '{"dependencies":{"new-dependency":"2.0.0"}}\n'),
        writeFile(lockPath, "mutated lock\n"),
        writeFile(join(root, "node_modules", "new-dependency", "marker.txt"), "new\n"),
        writeFile(artifactPath, "replacement artifact bytes\n"),
      ]);
      throw new Error("install failed");
    }),
    /install failed/,
  );

  assert.equal(await readFile(packagePath, "utf8"), originalPackage);
  assert.equal(await readFile(lockPath, "utf8"), originalLock);
  assert.equal(await readFile(unrelatedDependency, "utf8"), "preserve me\n");
  assert.equal(await readFile(artifactPath, "utf8"), "old artifact bytes\n");
  await assert.rejects(readFile(join(root, "node_modules", "new-dependency", "marker.txt")), { code: "ENOENT" });
});

test("transaction removes newly-created dependency state after a failed first install", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-transaction-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => {
      await mkdir(join(root, "node_modules", "temporary"), { recursive: true });
      await writeFile(join(root, "node_modules", "temporary", "marker.txt"), "new\n");
      await writeFile(join(root, "package.json"), "{\"dependencies\":{\"temporary\":\"1\"}}\n");
      throw new Error("first install failed");
    }),
    /first install failed/,
  );
  await assert.rejects(readFile(join(root, "node_modules", "temporary", "marker.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "package.json")), { code: "ENOENT" });
  const result = await withInstallTransaction(root, async () => "committed");
  assert.equal(result, "committed");
});

test("transaction accepts an explicitly injected filesystem adapter", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-transaction-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filesystem = {
    exists: existsSync,
    makeSiblingTemporaryDirectory: (projectRoot, prefix) => mkdtempSync(join(dirname(projectRoot), prefix)),
    readFile: readFileSync,
    copy: () => {},
    rename: renameSync,
    remove: rmSync,
    makeDirectory: (path) => mkdirSync(path, { recursive: true }),
    writeFile: writeFileSync,
  };
  assert.equal(await withInstallTransaction(root, async () => "adapter", filesystem), "adapter");
});

test("transaction keeps its backup beside the project to avoid cross-device rename", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-sibling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let backupRoot;
  await withInstallTransaction(root, async () => "sibling", {
    exists: existsSync,
    makeSiblingTemporaryDirectory: (projectRoot, prefix) => {
      backupRoot = mkdtempSync(join(dirname(projectRoot), prefix));
      return backupRoot;
    },
    readFile: readFileSync,
    copy: () => {},
    rename: renameSync,
    remove: rmSync,
    makeDirectory: (path) => mkdirSync(path, { recursive: true }),
    writeFile: writeFileSync,
  });
  assert.equal(dirname(backupRoot), dirname(root));
  assert.equal(existsSync(backupRoot), false);
});

test("transaction propagates rollback-directory allocation failure before invoking the install", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-rollback-allocation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let invoked = false;
  const unavailable = new Error("rollback directory unavailable");

  await assert.rejects(
    withInstallTransaction(root, async () => {
      invoked = true;
      return "unreachable";
    }, {
      exists: () => false,
      makeSiblingTemporaryDirectory: () => { throw unavailable; },
      readFile: readFileSync,
      copy: () => {},
      rename: renameSync,
      remove: rmSync,
      makeDirectory: (path) => mkdirSync(path, { recursive: true }),
      writeFile: writeFileSync,
    }),
    (error) => error === unavailable,
  );
  assert.equal(invoked, false);
});

test("a failed artifact backup leaves the original artifact untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-copy-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactPath = join(root, ".tsx-lvgl", "artifacts", "sdk.tgz");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, "original artifact\n");
  let invoked = false;

  await assert.rejects(
    withInstallTransaction(root, async () => {
      invoked = true;
    }, {
      exists: existsSync,
      makeSiblingTemporaryDirectory: (projectRoot, prefix) => mkdtempSync(join(dirname(projectRoot), prefix)),
      readFile: readFileSync,
      copy: () => { throw new Error("backup copy failed"); },
      rename: renameSync,
      remove: rmSync,
      makeDirectory: (path) => mkdirSync(path, { recursive: true }),
      writeFile: writeFileSync,
    }),
    /backup copy failed/,
  );

  assert.equal(invoked, false);
  assert.equal(await readFile(artifactPath, "utf8"), "original artifact\n");
});

test("artifact snapshot preflight rejects symlinks and FIFOs before action or rollback mutation", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-special-artifact-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  for (const kind of ["symlink", "fifo"]) {
    const root = join(sandbox, kind);
    const artifacts = join(root, ".tsx-lvgl", "artifacts");
    await mkdir(artifacts, { recursive: true });
    const special = join(artifacts, kind);
    if (kind === "symlink") {
      symlinkSync(join(sandbox, "outside"), special);
    } else {
      const result = spawnSync("mkfifo", [special], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    let invoked = false;
    await assert.rejects(
      withInstallTransaction(root, async () => {
        invoked = true;
      }),
      /artifact transaction source contains an unsupported entry/,
    );
    assert.equal(invoked, false);
    assert.equal(kind === "symlink" ? lstatSync(special).isSymbolicLink() : lstatSync(special).isFIFO(), true);
    assert.deepEqual(readdirSync(artifacts), [kind]);
  }
});
