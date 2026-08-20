import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import boardCatalog from "../packages/sdk/src/board-catalog.json" with { type: "json" };
import { listSupportedBoards, resolveCanonicalBoardId } from "../packages/sdk/dist/boards.js";
import {
  listFirmwareTargets,
  resolveBoardProfile,
  V1_TARGET,
  V2_TARGET,
} from "../scripts/board-profile.mjs";
import { generateBoardTargetIdHeader } from "../scripts/generate-board-target-id.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const V1_BOARD_ID = V1_TARGET.boardId;
const V2_BOARD_ID = V2_TARGET.boardId;
const V2_PROJECT = resolve(repoRoot, V2_TARGET.projectPath);

async function readTargetFile(target, relativePath) {
  return readFile(resolve(repoRoot, target.projectPath, relativePath), "utf8");
}

test("firmware registry is deterministic and keeps V1 support separate from V2 build-only status", async () => {
  const targets = listFirmwareTargets();
  assert.deepEqual(targets.map(({ targetKey }) => targetKey), [
    "waveshare-touch-amoled-1.8-v1",
    "waveshare-touch-amoled-1.8-v2",
  ]);
  assert.deepEqual(targets.map(({ boardId }) => boardId), [V1_BOARD_ID, V2_BOARD_ID]);
  assert.deepEqual(targets.map(({ supportStatus }) => supportStatus), ["supported", "experimental-build-only"]);
  assert.equal(new Set(targets.map(({ targetKey }) => targetKey)).size, targets.length);
  assert.equal(new Set(targets.map(({ boardId }) => boardId)).size, targets.length);

  for (const target of targets) {
    const profile = resolveBoardProfile(target.targetKey, repoRoot);
    assert.equal(profile.boardId, target.boardId);
    assert.equal(profile.supportStatus, target.supportStatus);
    assert.equal(existsSync(profile.projectDirectory), true);
    assert.equal(existsSync(profile.adapterDirectory), true);
    const manifest = JSON.parse(await readFile(profile.embeddedAppManifestPath, "utf8"));
    assert.equal(manifest.boardId, target.boardId, `${target.targetKey} app manifest must use its target ID`);
  }
});

test("V2 is visible to build tooling but rejected by consumer board selection", () => {
  const catalogV2 = boardCatalog.boards.find((board) => board.id === V2_BOARD_ID);
  assert.deepEqual(catalogV2, {
    id: V2_BOARD_ID,
    displayName: V2_TARGET.displayName,
    supportStatus: "experimental-build-only",
    legacyIds: [],
  });
  assert.deepEqual(listSupportedBoards().filter(({ supportStatus }) => supportStatus === "supported").map(({ id }) => id), [V1_BOARD_ID]);
  assert.throws(() => resolveCanonicalBoardId(V2_BOARD_ID), (error) => {
    assert.equal(error.code, "BOARD_TARGET_UNSUPPORTED");
    assert.equal(error.details.supportStatus, "experimental-build-only");
    assert.match(error.message, /build-only/);
    return true;
  });
});

test("target listing command is registry-derived and machine-readable", () => {
  const listing = spawnSync(process.execPath, ["scripts/list-board-targets.mjs", "--firmware", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(listing.status, 0, listing.stderr);
  const parsed = JSON.parse(listing.stdout);
  assert.equal(parsed.formatVersion, 1);
  assert.deepEqual(parsed.firmware.map(({ targetKey }) => targetKey), listFirmwareTargets().map(({ targetKey }) => targetKey));
  assert.equal(parsed.firmware.find(({ targetKey }) => targetKey.endsWith("-v2")).supportStatus, "experimental-build-only");
});

test("V2 composition pins the BSP and every directly managed display/touch/expander component", async () => {
  const manifest = await readTargetFile(V2_TARGET, "main/idf_component.yml");
  const lock = await readFile(resolve(V2_PROJECT, "dependencies.lock"), "utf8");
  assert.match(manifest, /waveshare\/esp32_s3_touch_amoled_1_8:\s*\n\s+version:\s+"2\.0\.3"/);
  assert.match(manifest, /espressif\/esp_lcd_co5300:\s+"2\.1\.0"/);
  assert.match(manifest, /espressif\/esp_lcd_touch_cst816s:\s+"1\.1\.2"/);
  assert.match(manifest, /espressif\/esp_io_expander_tca9554:\s+"2\.0\.3"/);
  assert.match(lock, /waveshare\/esp32_s3_touch_amoled_1_8:[\s\S]*?\n\s+version: 2\.0\.3/);
  assert.match(lock, /espressif\/esp_lcd_co5300:[\s\S]*?\n\s+version: 2\.1\.0/);
  assert.match(lock, /espressif\/esp_lcd_touch_cst816s:[\s\S]*?\n\s+version: 1\.1\.2/);
  assert.match(lock, /espressif\/esp_io_expander_tca9554:[\s\S]*?\n\s+version: 2\.0\.3/);
  assert.match(lock, /\n\s+version: 5\.5\.5\n/);
  assert.equal(V2_TARGET.bsp.version, "2.0.3");
  assert.deepEqual(V2_TARGET.bsp.dependencies, {
    "espressif/esp_lcd_co5300": "2.1.0",
    "espressif/esp_lcd_touch_cst816s": "1.1.2",
    "espressif/esp_io_expander_tca9554": "2.0.3",
  });
});

test("V2 adapter owns CO5300/CST identity and does not import the V1 driver composition", async () => {
  const adapter = await readTargetFile(V2_TARGET, "components/tsx_board_adapter_v2/tsx_board_adapter_v2.c");
  const identity = await readTargetFile(V2_TARGET, "components/tsx_board_adapter_v2/tsx_board_identity_v2.c");
  const cmake = await readTargetFile(V2_TARGET, "components/tsx_board_adapter_v2/CMakeLists.txt");
  const appMain = await readTargetFile(V2_TARGET, "main/app_main.c");
  assert.doesNotMatch(adapter, /bsp_display_start\(\)/);
  assert.match(adapter, /bsp_io_expander_init\(\)/);
  assert.match(adapter, /lvgl_port_add_disp\(/);
  assert.doesNotMatch(adapter, /lvgl_port_add_disp_rgb\(/);
  assert.match(adapter, /esp_lcd_touch_new_i2c_cst816s/);
  assert.match(adapter, /0x38U/);
  assert.match(adapter, /0x15U/);
  assert.match(adapter, /tsx_board_classify_v2_identity/);
  assert.match(adapter, /panel=co5300/);
  assert.match(appMain, /runtime_probe_app_main/);
  assert.doesNotMatch(cmake, /tsx_board_adapter_v1|waveshare_v1|esp_lcd_touch_ft5x06|esp_lcd_sh8601/i);
  assert.doesNotMatch(adapter, /tsx_board_adapter_v1|waveshare_v1|esp_lcd_touch_ft5x06|esp_lcd_sh8601/i);
  assert.doesNotMatch(identity, /esp_|i2c_|bsp_|freertos/i);
});

test("V2 boot evidence declares motion unavailable", async () => {
  const appMain = await readTargetFile(V2_TARGET, "main/app_main.c");
  assert.match(appMain, /motion=unavailable/);
  assert.doesNotMatch(appMain, /CO5300 \/ CST820 \/ QMI8658/);
});

test("generated V1/V2 target IDs, embedded manifests and transport handshakes form a cross-target matrix", async () => {
  const temporaryRoot = resolve(repoRoot, "test-dist", "firmware-target-matrix-generated");
  const generated = [];
  try {
    for (const target of [V1_TARGET, V2_TARGET]) {
      const profile = resolveBoardProfile(target.targetKey, repoRoot);
      const headerPath = resolve(temporaryRoot, `${target.targetKey}.h`);
      await generateBoardTargetIdHeader({ ...profile, targetIdHeaderPath: headerPath });
      const header = await readFile(headerPath, "utf8");
      assert.match(header, new RegExp(`#define TSX_BOARD_TARGET_ID ${JSON.stringify(target.boardId)}`));
      const manifest = JSON.parse(await readFile(profile.embeddedAppManifestPath, "utf8"));
      generated.push({ target, manifest });
    }

    const { createPushSession } = await import("../packages/bundler/dist/transport.js");
    for (const source of generated) {
      for (const device of generated) {
        const manifest = {
          ...source.manifest,
          generation: 1,
          byteLength: 1,
          sha256: "a".repeat(64),
        };
        const session = createPushSession(manifest, new Uint8Array([0x01]));
        assert.equal(session.begin().state, "awaiting-rdy");
        const progress = session.handle({
          kind: "line",
          line: `TSXB RDY maxBytes=1024 protocol=${manifest.protocolVersion} board=${device.target.boardId} lastGeneration=0`,
        });
        if (source.target.boardId === device.target.boardId) {
          assert.equal(progress.state, "sending", `${source.target.targetKey} -> ${device.target.targetKey}`);
          assert.match(progress.send[0], /^TSXB DATA /);
        } else {
          assert.equal(progress.state, "failed", `${source.target.targetKey} -> ${device.target.targetKey}`);
          assert.equal(progress.failure, "board mismatch");
          assert.deepEqual(progress.send, ["TSXB ABORT"]);
        }
      }
    }
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("V2 identity classifier compiles as strict C11 and covers the fail-closed policy", async () => {
  const temporaryDirectory = resolve(repoRoot, "test-dist", "firmware-target-matrix-c");
  const executable = resolve(temporaryDirectory, "board-identity-v2-fixture");
  const { mkdir, rm } = await import("node:fs/promises");
  await mkdir(temporaryDirectory, { recursive: true });
  try {
    const compile = spawnSync("cc", [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      "-I",
      resolve(V2_PROJECT, "components/tsx_board_adapter_v2/include"),
      "-I",
      resolve(repoRoot, "examples/esp-idf/components/tsx_board_adapter/include"),
      resolve(V2_PROJECT, "components/tsx_board_adapter_v2/tsx_board_identity_v2.c"),
      resolve(repoRoot, "tests/fixtures/board_identity_v2_fixture.c"),
      "-o",
      executable,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync(executable, [], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
