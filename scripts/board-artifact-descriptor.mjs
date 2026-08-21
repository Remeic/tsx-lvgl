import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  PARTITION_ENTRY_SIZE,
  PARTITION_TABLE_SIZE,
  parseEspPartitionTable,
} from "./esp-partition-table.mjs";

export const ARTIFACT_DESCRIPTOR_FORMAT_VERSION = 1;

const validatedLiveLayouts = new WeakSet();
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40,64}$/;

export class ArtifactDescriptorError extends Error {
  constructor(message, code = "ARTIFACT_DESCRIPTOR_INVALID") {
    super(message);
    this.name = "ArtifactDescriptorError";
    this.code = code;
  }
}

export class LiveLayoutValidationError extends Error {
  constructor(message, code = "LIVE_LAYOUT_MISMATCH") {
    super(message);
    this.name = "LiveLayoutValidationError";
    this.code = code;
  }
}

function fail(message, code = "ARTIFACT_DESCRIPTOR_INVALID") {
  throw new ArtifactDescriptorError(message, code);
}

function compactJson(value) {
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** ESP-IDF emits the used partition-table records without sector padding. */
function normalizeGeneratedPartitionTable(bytes) {
  if (bytes.byteLength === PARTITION_TABLE_SIZE) return bytes;
  if (bytes.byteLength === 0 || bytes.byteLength > PARTITION_TABLE_SIZE || bytes.byteLength % PARTITION_ENTRY_SIZE !== 0) {
    fail(`built partition table must be a complete sector or a record-aligned prefix`, "PARTITION_TABLE_INVALID");
  }
  const padded = Buffer.alloc(PARTITION_TABLE_SIZE, 0xff);
  bytes.copy(padded);
  return padded;
}

function assertInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
    fail(`${label} must be a ${positive ? "positive " : "non-negative "}safe integer`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
}

function normalizeRelativePath(value, label) {
  assertString(value, label);
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\0")) {
    fail(`${label} must be a relative path`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    fail(`${label} must stay inside the repository`);
  }
  return normalized;
}

function parseGeneratedFlashOffset(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    fail(`${label} must be a hexadecimal flash offset`, "BUILD_METADATA_INVALID");
  }
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(`${label} must be a safe non-negative flash offset`, "BUILD_METADATA_INVALID");
  }
  return parsed;
}

function generatedPath(metadataPath, value, label) {
  const normalized = normalizeRelativePath(value, label);
  const resolved = resolve(dirname(metadataPath), normalized);
  const relativePath = relative(dirname(metadataPath), resolved).split(sep).join("/");
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
    fail(`${label} must stay inside the generated build directory`, "BUILD_METADATA_INVALID");
  }
  return { normalized, resolved, relativePath };
}

function metadataFileEntries(metadata, metadataPath, flashSize) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("generated build metadata must be an object", "BUILD_METADATA_INVALID");
  }
  if (!metadata.flash_files || typeof metadata.flash_files !== "object" || Array.isArray(metadata.flash_files)) {
    fail("generated build metadata must contain a flash_files object", "BUILD_METADATA_INVALID");
  }
  assertInteger(flashSize, "target flash size", { positive: true });
  const entries = [];
  for (const [offsetText, path] of Object.entries(metadata.flash_files)) {
    const offset = parseGeneratedFlashOffset(offsetText, `flash_files.${offsetText}`);
    const generated = generatedPath(metadataPath, path, `flash_files.${offsetText}`);
    if (offset + PARTITION_TABLE_SIZE > flashSize) {
      fail(`flash_files.${offsetText} exceeds target flash size`, "BUILD_METADATA_INVALID");
    }
    entries.push(Object.freeze({
      offset,
      path: generated.resolved,
      relativePath: generated.relativePath,
    }));
  }
  return entries;
}

/**
 * Parse the structured ESP-IDF flasher output. The generated mapping is the
 * only source of the partition-table flash offset; no default is inferred.
 */
export function parseGeneratedBuildMetadata(metadata, {
  metadataPath,
  partitionTablePath,
  artifactPath,
  flashSize,
} = {}) {
  if (!isAbsolute(metadataPath ?? "")) {
    fail("generated build metadata path must be absolute", "BUILD_METADATA_INVALID");
  }
  if (!isAbsolute(partitionTablePath ?? "")) {
    fail("built partition-table path must be absolute", "BUILD_METADATA_INVALID");
  }
  const entries = metadataFileEntries(metadata, metadataPath, flashSize);
  const expectedPartitionPath = resolve(partitionTablePath);
  const partitionEntries = entries.filter((entry) => entry.path === expectedPartitionPath);
  if (partitionEntries.length === 0) {
    fail("generated build metadata does not bind the expected partition-table binary", "BUILD_METADATA_INVALID");
  }
  if (partitionEntries.length !== 1) {
    fail("generated build metadata binds the partition-table binary more than once", "BUILD_METADATA_INVALID");
  }
  const duplicatePaths = new Map();
  for (const entry of entries) {
    const offsets = duplicatePaths.get(entry.path) ?? [];
    offsets.push(entry.offset);
    duplicatePaths.set(entry.path, offsets);
  }
  for (const [path, offsets] of duplicatePaths) {
    if (offsets.length > 1) {
      fail(`generated build metadata binds ${path} at multiple flash offsets`, "BUILD_METADATA_INVALID");
    }
  }

  let artifactEntry = null;
  if (artifactPath !== undefined) {
    if (!isAbsolute(artifactPath)) {
      fail("built artifact path must be absolute", "BUILD_METADATA_INVALID");
    }
    const expectedArtifactPath = resolve(artifactPath);
    const matches = entries.filter((entry) => entry.path === expectedArtifactPath);
    if (matches.length !== 1) {
      fail("generated build metadata does not bind the expected application artifact", "BUILD_METADATA_INVALID");
    }
    artifactEntry = matches[0];
  }
  return Object.freeze({
    partitionTable: partitionEntries[0],
    artifact: artifactEntry,
  });
}

export async function readGeneratedBuildMetadata(buildMetadataPath, options = {}) {
  let text;
  try {
    text = await readFile(buildMetadataPath, "utf8");
  } catch (error) {
    throw new ArtifactDescriptorError(
      `cannot read generated build metadata: ${error instanceof Error ? error.message : String(error)}`,
      "BUILD_METADATA_READ_FAILED",
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch (error) {
    throw new ArtifactDescriptorError(
      `generated build metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "BUILD_METADATA_INVALID",
    );
  }
  return parseGeneratedBuildMetadata(metadata, { ...options, metadataPath: resolve(buildMetadataPath) });
}

function normalizeApplicationPartition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("applicationPartition must be an object");
  }
  assertString(value.label, "applicationPartition.label");
  assertInteger(value.type, "applicationPartition.type");
  assertInteger(value.subtype, "applicationPartition.subtype");
  assertInteger(value.offset, "applicationPartition.offset");
  assertInteger(value.size, "applicationPartition.size", { positive: true });
  return Object.freeze({
    label: value.label,
    type: value.type,
    subtype: value.subtype,
    offset: value.offset,
    size: value.size,
  });
}

function normalizeDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("artifact descriptor must be an object");
  }
  if (value.formatVersion !== ARTIFACT_DESCRIPTOR_FORMAT_VERSION) {
    fail(`unsupported artifact descriptor formatVersion: ${String(value.formatVersion)}`);
  }
  assertString(value.targetKey, "targetKey");
  assertString(value.boardId, "boardId");
  if (typeof value.sourceSha !== "string" || !SOURCE_SHA_PATTERN.test(value.sourceSha)) {
    fail("sourceSha must be a full hexadecimal Git object ID");
  }
  if (!value.artifact || typeof value.artifact !== "object" || Array.isArray(value.artifact)) {
    fail("artifact must be an object");
  }
  const artifactPath = normalizeRelativePath(value.artifact.path, "artifact.path");
  assertInteger(value.artifact.byteLength, "artifact.byteLength", { positive: true });
  if (typeof value.artifact.sha256 !== "string" || !SHA256_PATTERN.test(value.artifact.sha256)) {
    fail("artifact.sha256 must be a lowercase SHA-256 digest");
  }
  if (!value.partitionTable || typeof value.partitionTable !== "object" || Array.isArray(value.partitionTable)) {
    fail("partitionTable must be an object");
  }
  const partitionTableBinaryPath = normalizeRelativePath(value.partitionTable.binaryPath, "partitionTable.binaryPath");
  const buildMetadataPath = normalizeRelativePath(value.partitionTable.buildMetadataPath, "partitionTable.buildMetadataPath");
  assertInteger(value.partitionTable.flashOffset, "partitionTable.flashOffset");
  assertInteger(value.partitionTable.readSize, "partitionTable.readSize", { positive: true });
  if (value.partitionTable.readSize !== PARTITION_TABLE_SIZE) {
    fail(`partitionTable.readSize must be exactly ${PARTITION_TABLE_SIZE} bytes`);
  }
  assertInteger(value.partitionTable.flashSize, "partitionTable.flashSize", { positive: true });
  if (typeof value.partitionTable.semanticSha256 !== "string" || !SHA256_PATTERN.test(value.partitionTable.semanticSha256)) {
    fail("partitionTable.semanticSha256 must be a lowercase SHA-256 digest");
  }
  const applicationPartition = normalizeApplicationPartition(value.applicationPartition);
  if (applicationPartition.offset + applicationPartition.size > value.partitionTable.flashSize) {
    fail("applicationPartition exceeds the target flash size");
  }
  return Object.freeze({
    formatVersion: ARTIFACT_DESCRIPTOR_FORMAT_VERSION,
    targetKey: value.targetKey,
    boardId: value.boardId,
    sourceSha: value.sourceSha,
    artifact: Object.freeze({
      path: artifactPath,
      byteLength: value.artifact.byteLength,
      sha256: value.artifact.sha256,
    }),
    partitionTable: Object.freeze({
      binaryPath: partitionTableBinaryPath,
      buildMetadataPath,
      flashOffset: value.partitionTable.flashOffset,
      readSize: value.partitionTable.readSize,
      flashSize: value.partitionTable.flashSize,
      semanticSha256: value.partitionTable.semanticSha256,
    }),
    applicationPartition,
  });
}

function profilePartition(profile) {
  if (!profile || typeof profile !== "object") fail("board profile is required");
  const table = profile.partitionTable;
  if (!table || typeof table !== "object") fail("board profile has no partition-table metadata");
  return table;
}

function expectedArtifactPath(repositoryRoot, artifactPath) {
  const root = resolve(repositoryRoot);
  const resolvedArtifact = resolve(artifactPath);
  const value = relative(root, resolvedArtifact).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../")) {
    fail("artifact must be inside the repository for descriptor binding", "ARTIFACT_PATH_MISMATCH");
  }
  return value;
}

function artifactPathCandidates(repositoryRoot, artifactPath, descriptorPath) {
  const candidates = [];
  try {
    candidates.push(expectedArtifactPath(repositoryRoot, artifactPath));
  } catch {
    // An explicitly supplied custom artifact may live outside the repository.
    // In that case its descriptor may bind a path relative to the descriptor.
  }
  if (descriptorPath) {
    const value = relative(dirname(resolve(descriptorPath)), resolve(artifactPath)).split(sep).join("/");
    if (value && value !== ".." && !value.startsWith("../")) candidates.push(value);
  }
  return candidates;
}

function assertEqual(expected, observed, label, code = "ARTIFACT_DESCRIPTOR_MISMATCH") {
  if (expected !== observed) {
    throw new ArtifactDescriptorError(`${label} mismatch: expected ${String(expected)}, observed ${String(observed)}`, code);
  }
}

/**
 * Validate a descriptor against the selected target and the exact artifact.
 * This function performs no serial or other hardware access.
 */
export function validateArtifactDescriptor({
  descriptor,
  profile,
  artifactPath,
  artifactInfo,
  repositoryRoot = process.cwd(),
  sourceSha,
  expectedPartitionTableSemanticSha256,
  expectedPartitionTableFlashOffset,
  descriptorPath,
}) {
  const normalized = normalizeDescriptor(descriptor);
  if (profile) {
    assertEqual(profile.targetKey, normalized.targetKey, "target key", "TARGET_DESCRIPTOR_MISMATCH");
    assertEqual(profile.boardId, normalized.boardId, "board ID", "BOARD_DESCRIPTOR_MISMATCH");
    const table = profilePartition(profile);
    assertEqual(
      expectedArtifactPath(repositoryRoot, profile.partitionTableBinary),
      normalized.partitionTable.binaryPath,
      "partition-table binary path",
    );
    assertEqual(
      expectedArtifactPath(repositoryRoot, profile.buildMetadataPath),
      normalized.partitionTable.buildMetadataPath,
      "generated build metadata path",
    );
    assertEqual(table.readSize, normalized.partitionTable.readSize, "partition-table read size");
    assertEqual(table.flashSize, normalized.partitionTable.flashSize, "target flash size");
    if (expectedPartitionTableFlashOffset !== undefined) {
      assertEqual(
        normalized.partitionTable.flashOffset,
        expectedPartitionTableFlashOffset,
        "partition-table flash offset",
        "PARTITION_TABLE_DESCRIPTOR_MISMATCH",
      );
    }
    const expectedPartition = table.applicationPartition;
    for (const field of ["label", "type", "subtype", "offset", "size"]) {
      assertEqual(expectedPartition[field], normalized.applicationPartition[field], `application partition ${field}`);
    }
  }
  if (artifactPath) {
    if (!artifactPathCandidates(repositoryRoot, artifactPath, descriptorPath).includes(normalized.artifact.path)) {
      throw new ArtifactDescriptorError(
        `artifact path mismatch: expected one of ${compactJson(artifactPathCandidates(repositoryRoot, artifactPath, descriptorPath))}, observed ${normalized.artifact.path}`,
        "ARTIFACT_PATH_MISMATCH",
      );
    }
  }
  if (artifactInfo) {
    assertEqual(normalized.artifact.byteLength, artifactInfo.byteLength ?? artifactInfo.size, "artifact byte length", "ARTIFACT_SIZE_MISMATCH");
    assertEqual(normalized.artifact.sha256, artifactInfo.sha256, "artifact SHA-256", "ARTIFACT_DIGEST_MISMATCH");
  }
  if (sourceSha !== undefined) {
    assertEqual(normalized.sourceSha, sourceSha, "source SHA", "SOURCE_SHA_MISMATCH");
  }
  if (expectedPartitionTableSemanticSha256 !== undefined) {
    assertEqual(
      normalized.partitionTable.semanticSha256,
      expectedPartitionTableSemanticSha256,
      "partition-table semantic SHA-256",
      "PARTITION_TABLE_DESCRIPTOR_MISMATCH",
    );
  }
  return normalized;
}

export async function readArtifactDescriptor(descriptorPath) {
  let text;
  try {
    text = await readFile(descriptorPath, "utf8");
  } catch (error) {
    throw new ArtifactDescriptorError(
      `cannot read artifact descriptor: ${error instanceof Error ? error.message : String(error)}`,
      "DESCRIPTOR_READ_FAILED",
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ArtifactDescriptorError(
      `artifact descriptor is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "DESCRIPTOR_JSON_INVALID",
    );
  }
  return normalizeDescriptor(value);
}

/**
 * Create a descriptor from the generated artifact and the generated binary
 * partition table. The checked-in CSV is intentionally not an input here.
 */
export async function createArtifactDescriptor({
  repositoryRoot = process.cwd(),
  profile,
  targetKey = profile?.targetKey,
  boardId = profile?.boardId,
  sourceSha,
  artifactPath,
  partitionTablePath,
  buildMetadataPath = profile?.buildMetadataPath,
  outputPath,
}) {
  assertString(targetKey, "targetKey");
  assertString(boardId, "boardId");
  if (typeof sourceSha !== "string" || !SOURCE_SHA_PATTERN.test(sourceSha)) {
    fail("sourceSha must be a full hexadecimal Git object ID");
  }
  if (!artifactPath || !partitionTablePath || !buildMetadataPath) {
    fail("artifact, built partition-table and generated build metadata paths are required");
  }
  const table = profilePartition(profile);
  const [artifactBytes, partitionTableBytes, buildMetadata] = await Promise.all([
    readFile(artifactPath),
    readFile(partitionTablePath),
    readGeneratedBuildMetadata(buildMetadataPath, {
      partitionTablePath,
      artifactPath,
      flashSize: table.flashSize,
    }),
  ]);
  const parsedTable = parseEspPartitionTable(normalizeGeneratedPartitionTable(partitionTableBytes), {
    flashSize: table.flashSize,
  });
  if (table.readSize !== PARTITION_TABLE_SIZE) fail("board profile has unsupported partition-table geometry");
  const applicationPartition = parsedTable.entries.find((entry) => entry.label === table.applicationPartition.label);
  if (!applicationPartition) {
    fail(`built partition table has no application partition ${table.applicationPartition.label}`);
  }
  for (const field of ["label", "type", "subtype", "offset", "size"]) {
    assertEqual(table.applicationPartition[field], applicationPartition[field], `built application partition ${field}`);
  }
  assertEqual(
    applicationPartition.offset,
    buildMetadata.artifact.offset,
    "generated application artifact flash offset",
    "BUILD_METADATA_INVALID",
  );
  if (artifactBytes.byteLength > applicationPartition.size) {
    fail("built application artifact exceeds the selected application partition", "ARTIFACT_SIZE_MISMATCH");
  }
  const descriptor = normalizeDescriptor({
    formatVersion: ARTIFACT_DESCRIPTOR_FORMAT_VERSION,
    targetKey,
    boardId,
    sourceSha,
    artifact: {
      path: expectedArtifactPath(repositoryRoot, artifactPath),
      byteLength: artifactBytes.byteLength,
      sha256: sha256(artifactBytes),
    },
    partitionTable: {
      binaryPath: expectedArtifactPath(repositoryRoot, partitionTablePath),
      buildMetadataPath: expectedArtifactPath(repositoryRoot, buildMetadataPath),
      flashOffset: buildMetadata.partitionTable.offset,
      readSize: PARTITION_TABLE_SIZE,
      flashSize: table.flashSize,
      semanticSha256: parsedTable.semanticSha256,
    },
    applicationPartition,
  });
  if (outputPath) await writeArtifactDescriptor(outputPath, descriptor);
  return descriptor;
}

export async function writeArtifactDescriptor(outputPath, descriptor) {
  const normalized = normalizeDescriptor(descriptor);
  await writeFile(outputPath, `${compactJson(normalized)}\n`, { mode: 0o600 });
  return normalized;
}

function partitionMetadata(entry) {
  return entry === null ? null : {
    label: entry.label,
    type: entry.type,
    subtype: entry.subtype,
    offset: entry.offset,
    size: entry.size,
  };
}

function mismatch(expected, observed, reason) {
  const error = new LiveLayoutValidationError(
    `LIVE_LAYOUT_MISMATCH: ${reason}; expected=${compactJson(expected)} observed=${compactJson(observed)}`,
  );
  error.expected = Object.freeze(expected);
  error.observed = Object.freeze(observed);
  return error;
}

/**
 * Compare one read-only live sector with the immutable descriptor. Success
 * returns the opaque value accepted by buildReloadMutationPlan().
 */
export function compareLivePartitionTable({ descriptor, tableBytes, artifactByteLength }) {
  const normalized = normalizeDescriptor(descriptor);
  assertInteger(artifactByteLength, "artifactByteLength", { positive: true });
  let parsed;
  try {
    parsed = parseEspPartitionTable(tableBytes, { flashSize: normalized.partitionTable.flashSize });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LiveLayoutValidationError(`LIVE_LAYOUT_INVALID: ${reason}`, "LIVE_LAYOUT_INVALID");
  }

  const expectedPartition = normalized.applicationPartition;
  const observedPartition = parsed.entries.find((entry) => entry.label === expectedPartition.label) ?? null;
  const expectedMetadata = {
    semanticSha256: normalized.partitionTable.semanticSha256,
    applicationPartition: partitionMetadata(expectedPartition),
    artifactByteLength: normalized.artifact.byteLength,
  };
  const observedMetadata = {
    semanticSha256: parsed.semanticSha256,
    applicationPartition: partitionMetadata(observedPartition),
    artifactByteLength,
  };

  if (artifactByteLength !== normalized.artifact.byteLength) {
    throw mismatch(expectedMetadata, observedMetadata, "artifact byte length differs from descriptor");
  }
  if (parsed.semanticSha256 !== normalized.partitionTable.semanticSha256) {
    throw mismatch(expectedMetadata, observedMetadata, "partition-table semantic digest differs");
  }
  if (observedPartition === null) {
    throw mismatch(expectedMetadata, observedMetadata, "selected application partition is missing");
  }
  for (const field of ["label", "type", "subtype", "offset", "size"]) {
    if (observedPartition[field] !== expectedPartition[field]) {
      throw mismatch(expectedMetadata, observedMetadata, `application partition ${field} differs`);
    }
  }
  if (artifactByteLength > observedPartition.size) {
    throw mismatch(expectedMetadata, observedMetadata, "artifact is larger than the live application partition");
  }

  const validatedLayout = Object.freeze({
    targetKey: normalized.targetKey,
    boardId: normalized.boardId,
    semanticSha256: parsed.semanticSha256,
    rawSha256: parsed.rawSha256,
    applicationPartition: Object.freeze({ ...observedPartition }),
    artifactByteLength,
  });
  validatedLiveLayouts.add(validatedLayout);
  return validatedLayout;
}

export function isValidatedLiveLayout(value) {
  return Boolean(value && typeof value === "object" && validatedLiveLayouts.has(value));
}

export function assertValidatedLiveLayout(value) {
  if (!isValidatedLiveLayout(value)) {
    throw new LiveLayoutValidationError(
      "LIVE_LAYOUT_REQUIRED: mutation construction requires a validated live partition layout",
      "LIVE_LAYOUT_REQUIRED",
    );
  }
  return value;
}
