import { resolve } from "node:path";
import boardCatalog from "../packages/sdk/src/board-catalog.json" with { type: "json" };
import { readArtifactDescriptor, validateArtifactDescriptor } from "./board-artifact-descriptor.mjs";

const V1_TARGET = Object.freeze({
  targetKey: "waveshare-touch-amoled-1.8-v1",
  boardId: "waveshare.esp32s3.touch-amoled-1.8.v1",
  projectPath: "examples/esp-idf/runtime_port_probe",
  artifactPath: "examples/esp-idf/runtime_port_probe/build/tsx_lvgl_runtime_port_probe.bin",
  descriptorPath: "examples/esp-idf/runtime_port_probe/build/tsx_lvgl_runtime_port_probe.descriptor.json",
  buildMetadataPath: "examples/esp-idf/runtime_port_probe/build/flasher_args.json",
  partitionTablePath: "examples/esp-idf/runtime_port_probe/build/partition_table/partition-table.bin",
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
  embeddedAppDirectoryPath: "examples/esp-idf/runtime_port_probe/main",
  embeddedAppCodeFileName: "app.g1.js",
  embeddedAppManifestFileName: "app.g1.manifest.json",
});

const targets = new Map([[V1_TARGET.targetKey, V1_TARGET]]);

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
    projectDirectory: resolve(repoRoot, target.projectPath),
    artifact: resolve(repoRoot, target.artifactPath),
    descriptorPath: resolve(repoRoot, target.descriptorPath),
    buildMetadataPath: resolve(repoRoot, target.buildMetadataPath),
    partitionTableBinary: resolve(repoRoot, target.partitionTablePath),
    partitionTable: target.partitionTable,
    embeddedAppDirectory,
    embeddedAppCodePath: resolve(embeddedAppDirectory, target.embeddedAppCodeFileName),
    embeddedAppManifestPath: resolve(embeddedAppDirectory, target.embeddedAppManifestFileName),
  });
}

export { V1_TARGET };

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
