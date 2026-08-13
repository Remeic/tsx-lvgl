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
        const projectRootSync = events.findIndex((event) => event === `sync-directory:${basename(root)}`);
        const journalSync = events.findIndex((event) => event.startsWith("sync-file:.install-transaction.json."));
        assert.ok(projectRootSync >= 0, "a fresh .tsx-lvgl entry is durable in its project root");
        assert.ok(projectRootSync < journalSync, "the project root is durable before its journal is published");
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

test("transaction rejects a swapped rollback root without writing outside the project sibling", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-rollback-swap-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const outside = join(sandbox, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(outside, "keep.txt"), "outside state\n");

  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      beforeRollbackPersist: (rollbackRoot) => {
        rmSync(rollbackRoot, { recursive: true, force: true });
        symlinkSync(outside, rollbackRoot, "dir");
      },
    }),
    { code: "INSTALL_RECOVERY_FAILED" },
  );

  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "outside state\n");
  assert.equal(existsSync(join(outside, ".tsx-lvgl-install-owner.json")), false);
  recoverInterruptedInstall(root);
});

test("transaction refuses a preexisting journal temporary symlink", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-journal-symlink-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const outside = join(sandbox, "outside");
  await Promise.all([mkdir(join(root, ".tsx-lvgl"), { recursive: true }), mkdir(outside)]);
  const sentinel = join(outside, "sentinel.json");
  await writeFile(sentinel, "outside journal\n");

  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      beforeJournalTemporaryOpen: (temporary) => symlinkSync(sentinel, temporary),
    }),
    { code: "EEXIST" },
  );

  assert.equal(await readFile(sentinel, "utf8"), "outside journal\n");
  recoverInterruptedInstall(root);
  assert.equal(await readFile(sentinel, "utf8"), "outside journal\n");
});

test("recovery persists restored directories and metadata before its cleanup checkpoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-recovery-durability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "package.json");
  await mkdir(join(root, "node_modules", "before"), { recursive: true });
  await writeFile(packagePath, "{\"name\":\"before\"}\n");

  await assert.rejects(
    withInstallTransaction(root, async () => {
      await writeFile(packagePath, "{\"name\":\"after\"}\n");
    }, undefined, {
      afterTransition: (transition) => {
        if (transition === "action-completed") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );

  const rollbackRoot = readdirSync(dirname(root))
    .find((entry) => entry.startsWith(`.${basename(root)}.tsx-lvgl-install-rollback-`));
  assert.notEqual(rollbackRoot, undefined);
  const events = [];
  const filesystem = {
    ...DEFAULT_INSTALL_TRANSACTION_FS,
    syncFile: (path) => {
      if (basename(path).startsWith(".install-transaction.json.")) {
        const journal = JSON.parse(readFileSync(path, "utf8"));
        events.push(`journal:${journal.status}:${journal.directories[0].recovery}`);
      } else {
        events.push(`sync-file:${basename(path)}`);
      }
    },
    syncDirectory: (path) => events.push(`sync-directory:${basename(path)}`),
  };

  recoverInterruptedInstall(root, filesystem);
  const sourceSync = events.indexOf(`sync-directory:${rollbackRoot}`);
  const destinationSync = events.indexOf(`sync-directory:${basename(root)}`);
  const restoredJournal = events.indexOf("journal:active:restored");
  const metadataSync = events.indexOf("sync-file:package.json");
  const metadataParentSync = events.findIndex((event, index) => index > metadataSync && event === `sync-directory:${basename(root)}`);
  const cleanupJournal = events.indexOf("journal:cleanup:restored");
  assert.ok(sourceSync >= 0 && sourceSync < restoredJournal);
  assert.ok(destinationSync >= 0 && destinationSync < restoredJournal);
  assert.ok(metadataSync >= 0 && metadataSync < metadataParentSync && metadataParentSync < cleanupJournal);
  assert.equal(await readFile(packagePath, "utf8"), "{\"name\":\"before\"}\n");
});

test("restarted recovery persists a completed rename before advancing restored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-restarted-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules", "before"), { recursive: true });

  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "action-completed") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );

  let renamed = false;
  assert.throws(
    () => recoverInterruptedInstall(root, {
      ...DEFAULT_INSTALL_TRANSACTION_FS,
      rename: (from, to) => {
        renameSync(from, to);
        renamed = true;
      },
      syncDirectory: () => {
        if (renamed) throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );

  const rollbackRoot = readdirSync(dirname(root))
    .find((entry) => entry.startsWith(`.${basename(root)}.tsx-lvgl-install-rollback-`));
  assert.notEqual(rollbackRoot, undefined);
  const events = [];
  recoverInterruptedInstall(root, {
    ...DEFAULT_INSTALL_TRANSACTION_FS,
    syncFile: (path) => {
      if (basename(path).startsWith(".install-transaction.json.")) {
        const journal = JSON.parse(readFileSync(path, "utf8"));
        events.push(`journal:${journal.status}:${journal.directories[0].recovery}`);
      }
    },
    syncDirectory: (path) => events.push(`sync-directory:${basename(path)}`),
  });
  const sourceSync = events.indexOf(`sync-directory:${rollbackRoot}`);
  const destinationSync = events.indexOf(`sync-directory:${basename(root)}`);
  const restoredJournal = events.indexOf("journal:active:restored");
  assert.ok(sourceSync >= 0 && sourceSync < restoredJournal);
  assert.ok(destinationSync >= 0 && destinationSync < restoredJournal);
});

test("recovery cleans a pending owned rollback after interruption before first journal publication", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-pending-rollback-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const unrelated = join(sandbox, ".project.tsx-lvgl-install-rollback-unrelated");
  await Promise.all([mkdir(root), mkdir(unrelated)]);
  await writeFile(join(unrelated, "keep.txt"), "unrelated\n");

  await assert.rejects(
    withInstallTransaction(root, async () => "unreachable", undefined, {
      beforeJournalTemporaryOpen: () => { throw new InstallTransactionInterruptedError(); },
    }),
    InstallTransactionInterruptedError,
  );

  assert.equal(existsSync(join(root, ".tsx-lvgl", "install-transaction-pending.json")), true);
  assert.equal(readdirSync(dirname(root)).some((entry) => entry.startsWith(`.${basename(root)}.tsx-lvgl-install-rollback-`)), true);
  recoverInterruptedInstall(root);
  assert.equal(existsSync(join(root, ".tsx-lvgl", "install-transaction-pending.json")), false);
  assert.deepEqual(
    readdirSync(dirname(root)).filter((entry) => entry.startsWith(`.${basename(root)}.tsx-lvgl-install-rollback-`)),
    [basename(unrelated)],
  );
  assert.equal(await readFile(join(unrelated, "keep.txt"), "utf8"), "unrelated\n");
  assert.equal(await withInstallTransaction(root, async () => "recovered"), "recovered");
});

test("recovery does not delete a journal temporary after its state parent is swapped", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-stale-swap-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const state = join(root, ".tsx-lvgl");
  const outside = join(sandbox, "outside");
  await Promise.all([mkdir(state, { recursive: true }), mkdir(outside)]);

  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "journal-created") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );
  const journal = JSON.parse(await readFile(join(state, "install-transaction.json"), "utf8"));
  const temporary = `.install-transaction.json.${journal.rollbackToken}.orphan.tmp`;
  await writeFile(join(state, temporary), "owned temporary\n");
  await writeFile(join(outside, temporary), "outside temporary\n");

  assert.throws(
    () => recoverInterruptedInstall(root, undefined, {
      beforeOwnedJournalTemporaryCleanup: () => {
        rmSync(state, { recursive: true, force: true });
        symlinkSync(outside, state, "dir");
      },
    }),
    { code: "SOURCE_PATH_LEAK" },
  );
  assert.equal(await readFile(join(outside, temporary), "utf8"), "outside temporary\n");
});

test("recovery reports missing rollback metadata instead of silently continuing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-missing-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules", "keep"), { recursive: true });
  await mkdir(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
  await writeFile(join(root, "package.json"), "{\"name\":\"before\"}\n");

  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "journal-created") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );

  const rollbackRoot = join(
    dirname(root),
    readdirSync(dirname(root)).find((entry) => entry.startsWith(`.${basename(root)}.tsx-lvgl-install-rollback-`)),
  );
  rmSync(join(rollbackRoot, "metadata", "0"), { force: true });

  assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
});

test("recovery reports a missing rollback backup instead of silently continuing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-missing-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules", "keep"), { recursive: true });
  await writeFile(join(root, "node_modules", "keep", "marker.txt"), "before\n");

  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "node_modules-captured") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );

  const rollbackRoot = join(
    dirname(root),
    readdirSync(dirname(root)).find((entry) => entry.startsWith(`.${basename(root)}.tsx-lvgl-install-rollback-`)),
  );
  rmSync(join(rollbackRoot, "node_modules"), { recursive: true, force: true });

  assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
});

test("a transaction reports an unavailable project root instead of guessing its layout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-missing-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await rm(root, { recursive: true, force: true });
  await assert.rejects(
    withInstallTransaction(root, async () => "unreachable", undefined, {
      beforeJournalPersist: () => { rmSync(root, { recursive: true, force: true }); },
    }),
    { code: "SOURCE_PATH_LEAK" },
  );
});

test("recovery rejects a corrupted journal file instead of guessing its contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-corrupt-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "journal-created") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );
  writeFileSync(join(root, ".tsx-lvgl", "install-transaction.json"), "not json\n");
  assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
});

test("recovery rejects journals with a tampered shape at every validation stage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-journal-shape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "journal-created") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );
  const journalPath = join(root, ".tsx-lvgl", "install-transaction.json");
  const validJournal = readFileSync(journalPath, "utf8");

  for (const mutate of [
    (journal) => { journal.version = 2; },
    (journal) => { journal.rollbackDirectory = 123; },
    (journal) => { journal.rollbackToken = 123; },
    (journal) => { journal.rollbackToken = "z".repeat(64); },
    (journal) => { journal.status = "bogus"; },
    (journal) => { journal.metadata = journal.metadata.slice(1); },
    (journal) => { journal.directories = []; },
    (journal) => { journal.metadata[0] = 5; },
    (journal) => { journal.metadata[0] = { ...journal.metadata[0], path: "wrong.json" }; },
    (journal) => { journal.metadata[0] = { ...journal.metadata[0], existed: "yes" }; },
    (journal) => { journal.metadata[0] = { ...journal.metadata[0], backup: "wrong" }; },
  ]) {
    const tampered = JSON.parse(validJournal);
    mutate(tampered);
    writeFileSync(journalPath, `${JSON.stringify(tampered)}\n`);
    assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
  }

  writeFileSync(journalPath, validJournal);
  recoverInterruptedInstall(root);
});

test("recovery rejects a corrupted pending-rollback record instead of guessing its contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-corrupt-pending-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => "unreachable", undefined, {
      beforeJournalTemporaryOpen: () => { throw new InstallTransactionInterruptedError(); },
    }),
    InstallTransactionInterruptedError,
  );
  const pendingPath = join(root, ".tsx-lvgl", "install-transaction-pending.json");
  writeFileSync(pendingPath, "not json\n");
  assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
});

test("a transaction rejects a pending-rollback record it does not own", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-pending-mismatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => "unreachable", undefined, {
      beforeJournalPersist: (state) => {
        const pendingPath = join(state, "install-transaction-pending.json");
        const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
        writeFileSync(pendingPath, JSON.stringify({ ...pending, rollbackToken: "0".repeat(64) }));
      },
    }),
    { code: "INSTALL_RECOVERY_FAILED" },
  );
});

test("a transaction refuses a metadata backup directory that is a symlink", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-metadata-symlink-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  const outside = join(sandbox, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(root, "package.json"), "{\"name\":\"before\"}\n");

  await assert.rejects(
    withInstallTransaction(root, async () => "unreachable", {
      ...DEFAULT_INSTALL_TRANSACTION_FS,
      makeSiblingTemporaryDirectory: (projectRoot, prefix) => {
        const stage = mkdtempSync(join(dirname(projectRoot), prefix));
        symlinkSync(outside, join(stage, "metadata"), "dir");
        return stage;
      },
    }),
    { code: "INSTALL_RECOVERY_FAILED" },
  );
});

test("cleanup refuses to remove a rollback directory whose ownership cannot be verified", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-unowned-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "action-completed") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );

  const rollbackRoot = join(
    dirname(root),
    readdirSync(dirname(root)).find((entry) => entry.startsWith(`.${basename(root)}.tsx-lvgl-install-rollback-`)),
  );
  writeFileSync(join(rollbackRoot, ".tsx-lvgl-install-owner.json"), JSON.stringify({ version: 1, rollbackToken: "0".repeat(64) }));

  assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
});

test("artifact snapshot preflight rejects a non-directory artifacts path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-artifact-nondir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".tsx-lvgl"), { recursive: true });
  await writeFile(join(root, ".tsx-lvgl", "artifacts"), "not a directory\n");
  await assert.rejects(
    withInstallTransaction(root, async () => {}),
    /artifact transaction source must be a regular directory/,
  );
});

test("captured artifact snapshots reject a malformed backup produced by a custom copy adapter", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-artifact-backup-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const outside = join(sandbox, "outside");
  await mkdir(outside);

  for (const [kind, corrupt, message] of [
    ["file", (to) => writeFileSync(to, "not a directory"), /rollback artifact snapshot is not a regular directory/],
    ["symlink-entry", (to) => {
      mkdirSync(to, { recursive: true });
      symlinkSync(outside, join(to, "escape"), "dir");
    }, /rollback artifact snapshot contains an unsupported entry/],
  ]) {
    const root = join(sandbox, kind);
    await mkdir(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
    await writeFile(join(root, ".tsx-lvgl", "artifacts", "sdk.tgz"), "artifact\n");
    await assert.rejects(
      withInstallTransaction(root, async () => {}, {
        ...DEFAULT_INSTALL_TRANSACTION_FS,
        copy: (_from, to) => corrupt(to),
      }),
      message,
    );
  }
});

test("recovery resumes past a directory already marked restored on a prior interrupted pass", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-resume-restored-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules", "keep"), { recursive: true });
  await writeFile(join(root, "node_modules", "keep", "marker.txt"), "before\n");

  await assert.rejects(
    withInstallTransaction(root, async () => {
      await mkdir(join(root, "node_modules", "keep"), { recursive: true });
      await writeFile(join(root, "node_modules", "keep", "marker.txt"), "after\n");
    }, undefined, {
      afterTransition: (transition) => {
        if (transition === "action-completed") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );

  let existsCalls = 0;
  assert.throws(
    () => recoverInterruptedInstall(root, {
      ...DEFAULT_INSTALL_TRANSACTION_FS,
      exists: (path) => {
        existsCalls += 1;
        if (existsCalls === 4) throw new Error("interrupted mid-recovery");
        return existsSync(path);
      },
    }),
    /interrupted mid-recovery/,
  );

  recoverInterruptedInstall(root);
  assert.equal(await readFile(join(root, "node_modules", "keep", "marker.txt"), "utf8"), "before\n");
  assert.equal(existsSync(join(root, ".tsx-lvgl", "install-transaction.json")), false);
});

test("recovery rejects a journal path that is not a regular file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-journal-nonfile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "journal-created") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );
  const journalPath = join(root, ".tsx-lvgl", "install-transaction.json");
  rmSync(journalPath, { force: true });
  mkdirSync(journalPath);
  assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
});

test("recovery rejects a journal whose directory recovery marker is tampered", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-journal-directory-shape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "journal-created") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );
  const journalPath = join(root, ".tsx-lvgl", "install-transaction.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.directories[0].recovery = "bogus";
  writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
  assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
});

test("recovery rejects a journal whose rollback directory string is unsafe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-unsafe-rollback-string-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "journal-created") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );
  const journalPath = join(root, ".tsx-lvgl", "install-transaction.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.rollbackDirectory = "../escape";
  writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
  assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
});

test("recovery rejects a pending-rollback path that is not a regular file", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-pending-nonfile-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  await mkdir(root);

  await assert.rejects(
    withInstallTransaction(root, async () => "unreachable", undefined, {
      beforeJournalTemporaryOpen: () => { throw new InstallTransactionInterruptedError(); },
    }),
    InstallTransactionInterruptedError,
  );
  const pendingPath = join(root, ".tsx-lvgl", "install-transaction-pending.json");
  rmSync(pendingPath, { force: true });
  mkdirSync(pendingPath);
  assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
});

test("recovery rejects a well-formed but semantically invalid pending-rollback record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-pending-shape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => "unreachable", undefined, {
      beforeJournalTemporaryOpen: () => { throw new InstallTransactionInterruptedError(); },
    }),
    InstallTransactionInterruptedError,
  );
  const pendingPath = join(root, ".tsx-lvgl", "install-transaction-pending.json");
  writeFileSync(pendingPath, JSON.stringify({ version: 1, rollbackDirectory: "x", rollbackToken: "not-a-token" }));
  assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
});

test("cleanup refuses a rollback directory whose ownership marker is not a regular file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-owner-nonfile-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "action-completed") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );

  const rollbackRoot = join(
    dirname(root),
    readdirSync(dirname(root)).find((entry) => entry.startsWith(`.${basename(root)}.tsx-lvgl-install-rollback-`)),
  );
  const marker = join(rollbackRoot, ".tsx-lvgl-install-owner.json");
  rmSync(marker, { force: true });
  mkdirSync(marker);

  assert.throws(() => recoverInterruptedInstall(root), { code: "INSTALL_RECOVERY_FAILED" });
});

test("transaction rejects a project root replaced by a regular file before journal persistence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-root-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => "unreachable", undefined, {
      beforeJournalPersist: () => {
        rmSync(root, { recursive: true, force: true });
        writeFileSync(root, "not a directory");
      },
    }),
    { code: "SOURCE_PATH_LEAK" },
  );
});

test("cleanup refuses a rollback directory whose raw parent string no longer matches even though it canonically resolves beside the project", async (t) => {
  // assertRollbackDirectory (run once, up front, while creating the rollback directory)
  // compares canonical/realpath parents, so a symlinked alias for the sibling directory
  // passes it cleanly. cleanupOwnedRollbackDirectory instead compares the raw, non-canonical
  // parent string at cleanup time, so the very same alias trips its own independent guard.
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-rollback-parent-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "project");
  await mkdir(root);
  const alias = join(sandbox, "alias-sibling");
  symlinkSync(sandbox, alias, "dir");

  await assert.rejects(
    withInstallTransaction(root, async () => "done", {
      ...DEFAULT_INSTALL_TRANSACTION_FS,
      makeSiblingTemporaryDirectory: (_projectRoot, prefix) => mkdtempSync(join(alias, prefix)),
    }),
    { code: "INSTALL_RECOVERY_FAILED" },
  );
});

test("cleanup tolerates a rollback directory removed before its owned cleanup pass", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-rollback-gone-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "cleanup-recorded") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );
  const rollbackRoot = join(
    dirname(root),
    readdirSync(dirname(root)).find((entry) => entry.startsWith(`.${basename(root)}.tsx-lvgl-install-rollback-`)),
  );
  rmSync(rollbackRoot, { recursive: true, force: true });
  recoverInterruptedInstall(root);
  assert.equal(existsSync(join(root, ".tsx-lvgl", "install-transaction.json")), false);
});

test("cleanup tolerates a project state directory removed during its own cleanup pass", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-state-gone-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "cleanup-recorded") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );
  const state = join(root, ".tsx-lvgl");
  const rollbackRoot = join(
    dirname(root),
    readdirSync(dirname(root)).find((entry) => entry.startsWith(`.${basename(root)}.tsx-lvgl-install-rollback-`)),
  );
  const filesystem = {
    ...DEFAULT_INSTALL_TRANSACTION_FS,
    remove: (path, options) => {
      rmSync(path, options);
      if (path === rollbackRoot) rmSync(state, { recursive: true, force: true });
    },
  };
  recoverInterruptedInstall(root, filesystem);
  // cleanupJournal recreates the state directory to locate the journal path it still needs to
  // remove; the temporary-file sweep it skipped over left nothing behind either way.
  assert.equal(existsSync(join(state, "install-transaction.json")), false);
});

test("owned journal temporary cleanup removes matching files but skips non-regular entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-temp-nonregular-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "journal-created") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );
  const state = join(root, ".tsx-lvgl");
  const journal = JSON.parse(readFileSync(join(state, "install-transaction.json"), "utf8"));
  const bogusDir = join(state, `.install-transaction.json.${journal.rollbackToken}.bogus.tmp`);
  const orphanFile = join(state, `.install-transaction.json.${journal.rollbackToken}.orphan.tmp`);
  mkdirSync(bogusDir);
  writeFileSync(orphanFile, "orphan\n");

  recoverInterruptedInstall(root);

  assert.equal(existsSync(bogusDir), true);
  assert.equal(existsSync(orphanFile), false);
});

test("owned journal temporary cleanup re-validates a matched entry the hook swaps for a directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-temp-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withInstallTransaction(root, async () => {}, undefined, {
      afterTransition: (transition) => {
        if (transition === "journal-created") throw new InstallTransactionInterruptedError();
      },
    }),
    InstallTransactionInterruptedError,
  );
  const state = join(root, ".tsx-lvgl");
  const journal = JSON.parse(readFileSync(join(state, "install-transaction.json"), "utf8"));
  const temporary = join(state, `.install-transaction.json.${journal.rollbackToken}.swap.tmp`);
  writeFileSync(temporary, "temp\n");

  recoverInterruptedInstall(root, undefined, {
    beforeOwnedJournalTemporaryCleanup: (path) => {
      if (path === temporary) {
        rmSync(path, { force: true });
        mkdirSync(path);
      }
    },
  });

  assert.equal(existsSync(temporary), true);
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
