import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { partitionTableFixture, V1_PARTITION_TABLE_ENTRIES } from "./helpers/partition-table-fixture.mjs";
import boardCatalog from "../packages/sdk/src/board-catalog.json" with { type: "json" };
import {
  createArtifactDescriptor,
  readArtifactDescriptor,
  readGeneratedBuildMetadata,
  validateArtifactDescriptor,
} from "../scripts/board-artifact-descriptor.mjs";
import { resolveBoardProfile, resolveCatalogBoard, V1_TARGET } from "../scripts/board-profile.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const v1Table = partitionTableFixture(V1_PARTITION_TABLE_ENTRIES);

test("V1 target selects the one build project, artifact and board ID", () => {
  const profile = resolveBoardProfile("waveshare-touch-amoled-1.8-v1", root);
  assert.equal(profile.targetKey, "waveshare-touch-amoled-1.8-v1");
  assert.equal(profile.boardId, V1_TARGET.boardId);
  assert.equal(profile.boardId, boardCatalog.boards.find((board) => board.id === V1_TARGET.boardId).id);
  assert.equal(existsSync(profile.projectDirectory), true);
  assert.match(profile.artifact, /targets\/waveshare_touch_amoled_1_8_v1\/build\/tsx_lvgl_waveshare_v1\.bin$/);
  assert.match(profile.descriptorPath, /targets\/waveshare_touch_amoled_1_8_v1\/build\/tsx_lvgl_waveshare_v1\.descriptor\.json$/);
  assert.match(profile.buildMetadataPath, /targets\/waveshare_touch_amoled_1_8_v1\/build\/flasher_args\.json$/);
  assert.equal(profile.partitionTable.flashOffset, undefined);
  assert.match(profile.embeddedAppCodePath, /targets\/waveshare_touch_amoled_1_8_v1\/main\/app\.g1\.js$/);
  assert.match(profile.embeddedAppManifestPath, /targets\/waveshare_touch_amoled_1_8_v1\/main\/app\.g1\.manifest\.json$/);
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

test("catalog metadata drift fails closed for every duplicated field", () => {
  for (const field of ["displayName", "supportStatus"]) {
    const driftedCatalog = {
      formatVersion: 1,
      boards: boardCatalog.boards.map((board) => board.id === V1_TARGET.boardId
        ? { ...board, [field]: field === "displayName" ? "Drifted V1" : "experimental-build-only" }
        : board),
    };
    assert.throws(
      () => resolveCatalogBoard(V1_TARGET, driftedCatalog),
      new RegExp(`${field} disagrees with catalog`),
      `${field} drift must fail closed`,
    );
  }
});

test("unknown profiles cannot redirect build or artifact selection and list valid keys", () => {
  assert.throws(() => resolveBoardProfile("unknown", root), /unsupported board target: unknown\. Valid target keys: waveshare-touch-amoled-1\.8-v1/);
  assert.throws(() => resolveBoardProfile(undefined, root), /--target is required/);
});



function buildMetadataFixture({
  partitionTablePath = "partition_table/partition-table.bin",
  partitionTableOffset = "0x9000",
  artifactOffset = "0x10000",
} = {}) {
  return JSON.stringify({
    flash_files: {
      [partitionTableOffset]: partitionTablePath,
      [artifactOffset]: "tsx_lvgl_waveshare_v1.bin",
    },
  });
}

test("descriptor generation binds target, artifact and built partition semantics", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "tsx-lvgl-board-profile-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const profile = resolveBoardProfile(V1_TARGET.targetKey, temporaryRoot);
  await mkdir(resolve(temporaryRoot, "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/build/partition_table"), { recursive: true });
  await writeFile(profile.artifact, Buffer.from("generated firmware artifact"));
  await writeFile(profile.partitionTableBinary, v1Table);
  await writeFile(profile.buildMetadataPath, buildMetadataFixture());
  const sourceSha = "a".repeat(40);
  const descriptor = await createArtifactDescriptor({
    repositoryRoot: temporaryRoot,
    profile,
    sourceSha,
    artifactPath: profile.artifact,
    partitionTablePath: profile.partitionTableBinary,
    outputPath: profile.descriptorPath,
  });
  const loaded = await readArtifactDescriptor(profile.descriptorPath);
  const artifactInfo = {
    byteLength: Buffer.byteLength("generated firmware artifact"),
    sha256: createHash("sha256").update("generated firmware artifact").digest("hex"),
  };
  assert.deepEqual(loaded, descriptor);
  assert.equal(descriptor.partitionTable.flashOffset, 0x9000);
  assert.equal(descriptor.applicationPartition.offset, 0x10000);
  const generatedMetadata = await readGeneratedBuildMetadata(profile.buildMetadataPath, {
    partitionTablePath: profile.partitionTableBinary,
    artifactPath: profile.artifact,
    flashSize: profile.partitionTable.flashSize,
  });
  assert.equal(generatedMetadata.artifact.offset, descriptor.applicationPartition.offset);
  assert.equal(descriptor.partitionTable.binaryPath, "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/build/partition_table/partition-table.bin");
  assert.equal(descriptor.partitionTable.buildMetadataPath, "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/build/flasher_args.json");

  // ESP-IDF writes only the used 0xc00 bytes; descriptor parsing restores the
  // erased-sector padding before applying the strict partition-table contract.
  await writeFile(profile.partitionTableBinary, partitionTableFixture(V1_PARTITION_TABLE_ENTRIES).subarray(0, 0xc00));
  const normalizedDescriptor = await createArtifactDescriptor({
    repositoryRoot: temporaryRoot,
    profile,
    sourceSha,
    artifactPath: profile.artifact,
    partitionTablePath: profile.partitionTableBinary,
    outputPath: profile.descriptorPath,
  });
  assert.equal(normalizedDescriptor.partitionTable.semanticSha256, descriptor.partitionTable.semanticSha256);
  assert.doesNotThrow(() => validateArtifactDescriptor({
    descriptor: loaded,
    profile,
    artifactPath: profile.artifact,
    artifactInfo,
    repositoryRoot: temporaryRoot,
    sourceSha,
    expectedPartitionTableSemanticSha256: descriptor.partitionTable.semanticSha256,
  }));

  const mutations = [
    ["target key", (copy) => { copy.targetKey = "other-target"; }],
    ["board ID", (copy) => { copy.boardId = "other-board"; }],
    ["source SHA", (copy) => { copy.sourceSha = "b".repeat(40); }],
    ["artifact path", (copy) => { copy.artifact.path = "other.bin"; }],
    ["artifact byte length", (copy) => { copy.artifact.byteLength += 1; }],
    ["artifact digest", (copy) => { copy.artifact.sha256 = "b".repeat(64); }],
    ["partition semantic digest", (copy) => { copy.partitionTable.semanticSha256 = "b".repeat(64); }],
    ["application offset", (copy) => { copy.applicationPartition.offset += 0x1000; }],
  ];
  for (const [label, mutate] of mutations) {
    const copy = JSON.parse(JSON.stringify(descriptor));
    mutate(copy);
    assert.throws(() => validateArtifactDescriptor({
      descriptor: copy,
      profile,
      artifactPath: profile.artifact,
      artifactInfo,
      repositoryRoot: temporaryRoot,
      sourceSha,
      expectedPartitionTableSemanticSha256: descriptor.partitionTable.semanticSha256,
    }), new RegExp(label.split(" ")[0], "i"), label);
  }
});

test("descriptor generation fails closed when generated partition metadata is absent or inconsistent", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "tsx-lvgl-board-metadata-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const profile = resolveBoardProfile(V1_TARGET.targetKey, temporaryRoot);
  await mkdir(resolve(temporaryRoot, "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/build/partition_table"), { recursive: true });
  await writeFile(profile.artifact, Buffer.from("generated firmware artifact"));
  await writeFile(profile.partitionTableBinary, v1Table);
  const sourceSha = "a".repeat(40);
  const cases = [
    ["missing offset", JSON.stringify({ flash_files: { "0x10000": "tsx_lvgl_waveshare_v1.bin" } })],
    ["malformed offset", JSON.stringify({ flash_files: { invalid: "partition_table/partition-table.bin", "0x10000": "tsx_lvgl_waveshare_v1.bin" } })],
    ["inconsistent binary path", buildMetadataFixture({ partitionTablePath: "partition_table/other.bin" })],
    ["mismatched application artifact offset", buildMetadataFixture({ artifactOffset: "0x110000" })],
    ["inconsistent offset", JSON.stringify({ flash_files: {
      "0x9000": "partition_table/partition-table.bin",
      "0xa000": "partition_table/partition-table.bin",
      "0x10000": "tsx_lvgl_waveshare_v1.bin",
    } })],
  ];
  for (const [label, metadata] of cases) {
    await writeFile(profile.buildMetadataPath, metadata);
    await assert.rejects(createArtifactDescriptor({
      repositoryRoot: temporaryRoot,
      profile,
      sourceSha,
      artifactPath: profile.artifact,
      partitionTablePath: profile.partitionTableBinary,
      buildMetadataPath: profile.buildMetadataPath,
    }), /generated build metadata|generated application artifact|flash_files/i, label);
  }
});
