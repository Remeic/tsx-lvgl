import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import boardCatalog from "../packages/sdk/src/board-catalog.json" with { type: "json" };
import { resolveBoardProfile, resolveCatalogBoard, V1_TARGET } from "../scripts/board-profile.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("V1 target selects the one build project, artifact and board ID", () => {
  const profile = resolveBoardProfile("waveshare-touch-amoled-1.8-v1", root);
  assert.equal(profile.targetKey, "waveshare-touch-amoled-1.8-v1");
  assert.equal(profile.boardId, V1_TARGET.boardId);
  assert.equal(profile.boardId, boardCatalog.boards.find((board) => board.id === V1_TARGET.boardId).id);
  assert.equal(existsSync(profile.projectDirectory), true);
  assert.match(profile.artifact, /runtime_port_probe\/build\/tsx_lvgl_runtime_port_probe\.bin$/);
  assert.match(profile.embeddedAppCodePath, /runtime_port_probe\/main\/app\.g1\.js$/);
  assert.match(profile.embeddedAppManifestPath, /runtime_port_probe\/main\/app\.g1\.manifest\.json$/);
  assert.equal(Object.isFrozen(profile), true);
});

test("catalog additions and reordering cannot retarget the V1 profile", () => {
  const futureBoard = {
    id: "future.board.v2",
    displayName: "Future board (V2)",
    legacyIds: [],
  };
  const reorderedCatalog = {
    formatVersion: 1,
    boards: [futureBoard, ...[...boardCatalog.boards].reverse()],
  };

  assert.equal(resolveCatalogBoard(V1_TARGET, reorderedCatalog).id, V1_TARGET.boardId);
});

test("unknown profiles cannot redirect build or artifact selection and list valid keys", () => {
  assert.throws(() => resolveBoardProfile("unknown", root), /unsupported board target: unknown\. Valid target keys: waveshare-touch-amoled-1\.8-v1/);
  assert.throws(() => resolveBoardProfile(undefined, root), /--target is required/);
});
