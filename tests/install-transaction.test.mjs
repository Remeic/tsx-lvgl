import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withInstallTransaction } from "../packages/sdk/dist/install-transaction.js";

test("failed install restores all prior dependency and metadata state atomically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-install-transaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "package.json");
  const lockPath = join(root, "pnpm-lock.yaml");
  const unrelatedDependency = join(root, "node_modules", "unrelated", "marker.txt");
  const originalPackage = '{"dependencies":{"unrelated":"1.0.0"}}\n';
  const originalLock = "lockfileVersion: '9.0'\n";
  await mkdir(join(root, "node_modules", "unrelated"), { recursive: true });
  await Promise.all([
    writeFile(packagePath, originalPackage),
    writeFile(lockPath, originalLock),
    writeFile(unrelatedDependency, "preserve me\n"),
  ]);

  await assert.rejects(
    withInstallTransaction(root, async () => {
      await mkdir(join(root, "node_modules", "new-dependency"), { recursive: true });
      await Promise.all([
        writeFile(packagePath, '{"dependencies":{"new-dependency":"2.0.0"}}\n'),
        writeFile(lockPath, "mutated lock\n"),
        writeFile(join(root, "node_modules", "new-dependency", "marker.txt"), "new\n"),
      ]);
      throw new Error("install failed");
    }),
    /install failed/,
  );

  assert.equal(await readFile(packagePath, "utf8"), originalPackage);
  assert.equal(await readFile(lockPath, "utf8"), originalLock);
  assert.equal(await readFile(unrelatedDependency, "utf8"), "preserve me\n");
  await assert.rejects(readFile(join(root, "node_modules", "new-dependency", "marker.txt")), { code: "ENOENT" });
});
