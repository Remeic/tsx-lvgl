import { resolve } from "node:path";
import boardCatalog from "../packages/sdk/src/board-catalog.json" with { type: "json" };
import { readArtifactDescriptor, validateArtifactDescriptor } from "./board-artifact-descriptor.mjs";

const V1_TARGET = Object.freeze({
  targetKey: "waveshare-touch-amoled-1.8-v1",
  boardId: "waveshare.esp32s3.touch-amoled-1.8.v1",
  displayName: "Waveshare ESP32-S3 Touch AMOLED 1.8 (V1)",
  supportStatus: "supported",
  adapterPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/components/tsx_board_adapter_v1",
  bsp: Object.freeze({
    name: "waveshare/esp32_s3_touch_amoled_1_8",
    version: "1.1.4",
    display: "SH8601",
    touch: "FT3168",
  }),
  projectPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1",
  artifactPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/build/tsx_lvgl_waveshare_v1.bin",
  descriptorPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/build/tsx_lvgl_waveshare_v1.descriptor.json",
  buildMetadataPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/build/flasher_args.json",
  partitionTablePath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/build/partition_table/partition-table.bin",
  targetIdHeaderPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/main/generated/tsx_board_target_id.h",
  partitionTable: Object.freeze({
    readSize: 0x1000,
    flashSize: 0x1000000,
    applicationPartition: Object.freeze({
      label: "factory",
      type: 0,
      subtype: 0,
      offset: 0x10000,
      size: 0x800000,
    }),
  }),
  embeddedAppDirectoryPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/main",
  embeddedAppCodeFileName: "app.g1.js",
  embeddedAppManifestFileName: "app.g1.manifest.json",
});

const V2_TARGET = Object.freeze({
  targetKey: "waveshare-touch-amoled-1.8-v2",
  boardId: "waveshare.esp32s3.touch-amoled-1.8.v2",
  displayName: "Waveshare ESP32-S3 Touch AMOLED 1.8 (V2)",
  // Physical display/touch and stock-layout acceptance are intentionally not
  // present yet. This status is visible in the SDK catalog and does not grant
  // consumer install or reload support.
  supportStatus: "experimental-build-only",
  adapterPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v2/components/tsx_board_adapter_v2",
  bsp: Object.freeze({
    name: "waveshare/esp32_s3_touch_amoled_1_8",
    version: "2.0.3",
    display: "CO5300",
    touch: "CST820 (CST816S-compatible API)",
    dependencies: Object.freeze({
      "espressif/esp_lcd_co5300": "2.1.0",
      "espressif/esp_lcd_touch_cst816s": "1.1.2",
      "espressif/esp_io_expander_tca9554": "2.0.3",
    }),
  }),
  projectPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v2",
  artifactPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v2/build/tsx_lvgl_waveshare_v2.bin",
  descriptorPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v2/build/tsx_lvgl_waveshare_v2.descriptor.json",
  buildMetadataPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v2/build/flasher_args.json",
  partitionTablePath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v2/build/partition_table/partition-table.bin",
  targetIdHeaderPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v2/main/generated/tsx_board_target_id.h",
  partitionTable: Object.freeze({
    readSize: 0x1000,
    flashSize: 0x1000000,
    applicationPartition: Object.freeze({
      label: "factory",
      type: 0,
      subtype: 0,
      offset: 0x10000,
      size: 0x800000,
    }),
  }),
  embeddedAppDirectoryPath: "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v2/main",
  embeddedAppCodeFileName: "app.g1.js",
  embeddedAppManifestFileName: "app.g1.manifest.json",
});

const targets = new Map([
  [V1_TARGET.targetKey, V1_TARGET],
  [V2_TARGET.targetKey, V2_TARGET],
]);

export function resolveCatalogBoard(target, catalog = boardCatalog) {
  if (catalog.formatVersion !== 1 || !Array.isArray(catalog.boards)) {
    throw new Error("board catalog must declare formatVersion 1 and a boards array");
  }
  const board = catalog.boards.find((candidate) => candidate.id === target.boardId);
  if (board === undefined || typeof board.id !== "string") {
    throw new Error(`board target ${target.targetKey} does not resolve to a catalog board`);
  }
  return board;
}

/** Resolves repository-only build and reload metadata for an explicit target. */
export function resolveBoardProfile(targetKey, repoRoot = process.cwd()) {
  if (typeof targetKey !== "string" || targetKey.trim().length === 0) {
    throw new Error("--target is required");
  }
  const target = targets.get(targetKey);
  if (target === undefined) {
    throw new Error(`unsupported board target: ${targetKey}. Valid target keys: ${[...targets.keys()].join(", ")}`);
  }
  const board = resolveCatalogBoard(target);
  const embeddedAppDirectory = resolve(repoRoot, target.embeddedAppDirectoryPath);
  return Object.freeze({
    targetKey: target.targetKey,
    boardId: board.id,
    displayName: target.displayName,
    supportStatus: target.supportStatus,
    adapterDirectory: resolve(repoRoot, target.adapterPath),
    bsp: target.bsp,
    projectDirectory: resolve(repoRoot, target.projectPath),
    artifact: resolve(repoRoot, target.artifactPath),
    descriptorPath: resolve(repoRoot, target.descriptorPath),
    buildMetadataPath: resolve(repoRoot, target.buildMetadataPath),
    partitionTableBinary: resolve(repoRoot, target.partitionTablePath),
    targetIdHeaderPath: resolve(repoRoot, target.targetIdHeaderPath),
    partitionTable: target.partitionTable,
    embeddedAppDirectory,
    embeddedAppCodePath: resolve(embeddedAppDirectory, target.embeddedAppCodeFileName),
    embeddedAppManifestPath: resolve(embeddedAppDirectory, target.embeddedAppManifestFileName),
  });
}

/** Return all firmware targets in stable target-key order for CI/tooling. */
export function listFirmwareTargets() {
  return Object.freeze([...targets.values()]
    .sort((left, right) => left.targetKey.localeCompare(right.targetKey))
    .map((target) => Object.freeze({
      targetKey: target.targetKey,
      boardId: target.boardId,
      displayName: target.displayName,
      supportStatus: target.supportStatus,
      projectPath: target.projectPath,
      adapterPath: target.adapterPath,
      artifactPath: target.artifactPath,
      descriptorPath: target.descriptorPath,
      buildMetadataPath: target.buildMetadataPath,
      partitionTablePath: target.partitionTablePath,
      targetIdHeaderPath: target.targetIdHeaderPath,
      bsp: target.bsp,
    })));
}

export { V1_TARGET, V2_TARGET };

/** Load and validate the descriptor bound to a resolved target profile. */
export async function loadBoardArtifactDescriptor(profile, {
  artifactPath = profile.artifact,
  descriptorPath = profile.descriptorPath,
  artifactInfo,
  repositoryRoot = process.cwd(),
  sourceSha,
  expectedPartitionTableSemanticSha256,
} = {}) {
  const descriptor = await readArtifactDescriptor(descriptorPath);
  return validateArtifactDescriptor({
    descriptor,
    profile,
    artifactPath,
    descriptorPath,
    artifactInfo,
    repositoryRoot,
    sourceSha,
    expectedPartitionTableSemanticSha256,
  });
}
