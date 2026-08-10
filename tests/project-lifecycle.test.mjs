import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildProject,
  checkProject,
  createProject,
  devProject,
  doctorProject,
  syncProject,
  updateProject,
} from "../packages/sdk/dist/project.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("project lifecycle is executable in-process through the public SDK facade", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-project-lifecycle-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const artifactRoot = join(sandbox, "artifact");
  const pack = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "pack-sdk.mjs"), "--out", artifactRoot, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const artifactPath = JSON.parse(pack.stdout).artifactPath;
  const root = join(sandbox, "app");

  const created = await createProject(root, artifactPath);
  assert.equal(created.root, root);
  assert.equal(existsSync(join(root, ".tsx-lvgl", "framework.lock.json")), true);
  assert.deepEqual(checkProject(root).files, ["src/App.tsx"]);
  const build = buildProject(root);
  assert.equal(existsSync(join(root, build.codePath)), true);
  assert.equal((await devProject(root)).texts[0], "Hello TSX-LVGL");
  const doctor = doctorProject(root);
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  assert.equal((await syncProject(root)).lock.sourceSha, created.lock.sourceSha);
  assert.equal((await updateProject(root, repositoryRoot)).lock.sourceSha, created.lock.sourceSha);
});
