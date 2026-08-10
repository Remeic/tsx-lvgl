import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  DEFAULT_INSTALL_TRANSACTION_FS,
  InstallTransactionInterruptedError,
  recoverInterruptedInstall,
  withInstallTransaction,
} from "../packages/sdk/dist/install-transaction.js";

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

test("restart recovery restores every durable transaction checkpoint idempotently", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-restart-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  for (const checkpoint of [
    "journal-created",
    "node_modules-captured",
    "artifacts-captured",
    "action-completed",
  ]) {
    const root = join(sandbox, checkpoint);
    const packagePath = join(root, "package.json");
    const artifactPath = join(root, ".tsx-lvgl", "artifacts", "sdk.tgz");
    await mkdir(join(root, "node_modules", "keep"), { recursive: true });
    await mkdir(dirname(artifactPath), { recursive: true });
    await Promise.all([
      writeFile(packagePath, "{\"name\":\"before\"}\n"),
      writeFile(join(root, "node_modules", "keep", "marker.txt"), "before node modules\n"),
      writeFile(artifactPath, "before artifact\n"),
    ]);

    await assert.rejects(
      withInstallTransaction(
        root,
        async () => {
          await mkdir(join(root, "node_modules", "new"), { recursive: true });
          await writeFile(join(root, "node_modules", "new", "marker.txt"), "after node modules\n");
          await writeFile(packagePath, "{\"name\":\"after\"}\n");
          await writeFile(artifactPath, "after artifact\n");
        },
        undefined,
        {
          afterTransition: (transition) => {
            if (transition === checkpoint) throw new InstallTransactionInterruptedError();
          },
        },
      ),
      InstallTransactionInterruptedError,
    );

    recoverInterruptedInstall(root);
    recoverInterruptedInstall(root);
    assert.equal(await readFile(packagePath, "utf8"), "{\"name\":\"before\"}\n");
    assert.equal(await readFile(join(root, "node_modules", "keep", "marker.txt"), "utf8"), "before node modules\n");
    await assert.rejects(readFile(join(root, "node_modules", "new", "marker.txt")), { code: "ENOENT" });
    assert.equal(await readFile(artifactPath, "utf8"), "before artifact\n");
    assert.equal(existsSync(join(root, ".tsx-lvgl", "install-transaction.json")), false);
    assert.equal(
      readdirSync(dirname(root)).some((entry) => entry.startsWith(`.${checkpoint}.tsx-lvgl-install-rollback-`)),
      false,
    );
  }
});

test("journal durability is acknowledged before a mutable directory rename", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-durability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules", "keep"), { recursive: true });
  const events = [];
  const filesystem = {
    ...DEFAULT_INSTALL_TRANSACTION_FS,
    rename: (from, to) => {
      events.push(`rename:${from}`);
      renameSync(from, to);
    },
    syncFile: (path) => events.push(`sync-file:${basename(path)}`),
    syncDirectory: (path) => events.push(`sync-directory:${basename(path)}`),
  };

  await assert.rejects(
    withInstallTransaction(root, async () => {}, filesystem, {
      afterTransition: (transition) => {
        if (transition !== "journal-created") return;
        assert.equal(events.some((event) => event === "sync-file:.tsx-lvgl-install-owner.json"), true);
        assert.equal(events.some((event) => event.startsWith("sync-file:.install-transaction.json.")), true);
        assert.equal(events.some((event) => event.endsWith("node_modules")), false);
        throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );
  recoverInterruptedInstall(root);
});

test("recovery preserves an unjournaled sibling directory and rejects a swapped state parent", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-ownership-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const unrelated = join(sandbox, ".project.tsx-lvgl-install-rollback-unrelated");
  const outside = join(sandbox, "outside");
  await mkdir(join(root, ".tsx-lvgl"), { recursive: true });
  await mkdir(unrelated);
  await mkdir(outside);
  await writeFile(join(unrelated, "keep.txt"), "unrelated\n");

  recoverInterruptedInstall(root);
  assert.equal(await readFile(join(unrelated, "keep.txt"), "utf8"), "unrelated\n");

  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      beforeJournalPersist: (state) => {
        rmSync(state, { recursive: true, force: true });
        symlinkSync(outside, state, "dir");
      },
    }),
    { code: "SOURCE_PATH_LEAK" },
  );
  assert.equal(existsSync(join(outside, "install-transaction.json")), false);
});

test("recovery keeps a committed transaction when interruption follows its cleanup checkpoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-committed-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "package.json");
  await writeFile(packagePath, "{\"name\":\"before\"}\n");

  await assert.rejects(
    withInstallTransaction(root, async () => {
      await writeFile(packagePath, "{\"name\":\"after\"}\n");
    }, undefined, {
      afterTransition: (transition) => {
        if (transition === "cleanup-recorded") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );

  recoverInterruptedInstall(root);
  recoverInterruptedInstall(root);
  assert.equal(await readFile(packagePath, "utf8"), "{\"name\":\"after\"}\n");
  assert.equal(existsSync(join(root, ".tsx-lvgl", "install-transaction.json")), false);
});
