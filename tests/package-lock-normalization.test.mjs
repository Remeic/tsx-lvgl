import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";
import { synchronizePackageLock } from "../packages/sdk/dist/project.js";

test("npm lock normalization handles modern and legacy records and fails closed on absent SDK entries", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tsx-lvgl-package-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = join(root, ".tsx-lvgl", "artifacts", "sdk.tgz");
  const modern = join(root, "modern.json");
  const legacy = join(root, "legacy.json");
  mkdirSync(join(root, ".tsx-lvgl", "artifacts"), { recursive: true });
  writeFileSync(artifact, "artifact");
  writeFileSync(modern, JSON.stringify({ packages: { "": { dependencies: {} }, "node_modules/@tsx-lvgl/sdk": {} } }));
  synchronizePackageLock(modern, root, artifact);
  const normalizedModern = JSON.parse(readFileSync(modern));
  assert.equal(normalizedModern.packages[""].dependencies["@tsx-lvgl/sdk"], "file:.tsx-lvgl/artifacts/sdk.tgz");
  assert.match(normalizedModern.packages["node_modules/@tsx-lvgl/sdk"].integrity, /^sha512-/);
  writeFileSync(legacy, JSON.stringify({ dependencies: { "@tsx-lvgl/sdk": {} } }));
  synchronizePackageLock(legacy, root, artifact);
  assert.equal(JSON.parse(readFileSync(legacy)).dependencies["@tsx-lvgl/sdk"].resolved, "file:.tsx-lvgl/artifacts/sdk.tgz");
  writeFileSync(modern, JSON.stringify({ packages: {} }));
  assert.throws(() => synchronizePackageLock(modern, root, artifact), { code: DIAGNOSTIC_CODES.INSTALL_FAILED });
  writeFileSync(legacy, JSON.stringify({ dependencies: {} }));
  assert.throws(() => synchronizePackageLock(legacy, root, artifact), { code: DIAGNOSTIC_CODES.INSTALL_FAILED });
});
