import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveBoardProfile } from "../scripts/board-profile.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("runtime-probe profile selects the one build project and guarded artifact", () => {
  const profile = resolveBoardProfile("runtime-probe", root);
  assert.equal(profile.name, "runtime-probe");
  assert.equal(existsSync(profile.projectDirectory), true);
  assert.match(profile.artifact, /runtime_port_probe\/build\/tsx_lvgl_runtime_port_probe\.bin$/);
  assert.match(profile.embeddedAppCodePath, /runtime_port_probe\/main\/app\.g1\.js$/);
  assert.match(profile.embeddedAppManifestPath, /runtime_port_probe\/main\/app\.g1\.manifest\.json$/);
  assert.equal(Object.isFrozen(profile), true);
});

test("unknown profiles cannot redirect build or artifact selection", () => {
  assert.throws(() => resolveBoardProfile("unknown", root), /unsupported board profile/);
});
