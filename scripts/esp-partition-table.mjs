import { createHash, timingSafeEqual } from "node:crypto";

export const PARTITION_TABLE_SIZE = 0x1000;
export const PARTITION_TABLE_DATA_SIZE = 0xc00;
export const PARTITION_ENTRY_SIZE = 0x20;
export const PARTITION_ENTRY_MAGIC = Object.freeze([0xaa, 0x50]);
export const MD5_ENTRY_MAGIC = Object.freeze([0xeb, 0xeb]);
export const PARTITION_TABLE_FORMAT_VERSION = 1;

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class PartitionTableError extends Error {
  constructor(message, code = "PARTITION_TABLE_INVALID") {
    super(message);
    this.name = "PartitionTableError";
    this.code = code;
  }
}

function fail(message) {
  throw new PartitionTableError(message);
}

function assertBytes(input) {
  if (!(input instanceof Uint8Array)) {
    fail("partition table must be a Uint8Array");
  }
  if (input.byteLength !== PARTITION_TABLE_SIZE) {
    fail(`partition table must be exactly ${PARTITION_TABLE_SIZE} bytes`);
  }
}

function allBytesAre(value, expected) {
  for (const byte of value) {
    if (byte !== expected) return false;
  }
  return true;
}

function isEndEntry(bytes, offset) {
  return allBytesAre(bytes.subarray(offset, offset + PARTITION_ENTRY_SIZE), 0xff);
}

function isMd5Entry(bytes, offset) {
  if (bytes[offset] !== MD5_ENTRY_MAGIC[0] || bytes[offset + 1] !== MD5_ENTRY_MAGIC[1]) {
    return false;
  }
  for (let index = offset + 2; index < offset + 16; index += 1) {
    if (bytes[index] !== 0xff) return false;
  }
  return true;
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function readUint32(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function parseLabel(bytes, offset) {
  const labelBytes = bytes.subarray(offset, offset + 16);
  const zeroIndex = labelBytes.indexOf(0);
  const end = zeroIndex === -1 ? labelBytes.length : zeroIndex;
  if (zeroIndex !== -1) {
    for (let index = zeroIndex + 1; index < labelBytes.length; index += 1) {
      if (labelBytes[index] !== 0) {
        fail("partition label contains non-zero data after its terminator");
      }
    }
  }
  let label;
  try {
    label = textDecoder.decode(labelBytes.subarray(0, end));
  } catch {
    fail("partition label is not valid UTF-8");
  }
  if (label.length === 0) fail("partition label must be non-empty");
  return label;
}

function validateFlashRange(entry, flashSize) {
  if (!Number.isSafeInteger(flashSize) || flashSize <= 0) {
    fail("target flash size must be a positive safe integer");
  }
  if (entry.size === 0) fail(`partition ${entry.label} has zero size`);
  if (entry.offset + entry.size > flashSize) {
    fail(`partition ${entry.label} exceeds target flash size`);
  }
}

function parseNormalEntry(bytes, offset, flashSize) {
  if (bytes[offset] !== PARTITION_ENTRY_MAGIC[0] || bytes[offset + 1] !== PARTITION_ENTRY_MAGIC[1]) {
    fail(`invalid partition entry magic at 0x${offset.toString(16)}`);
  }

  const entry = {
    label: parseLabel(bytes, offset + 12),
    type: bytes[offset + 2],
    subtype: bytes[offset + 3],
    offset: readUint32(bytes, offset + 4),
    size: readUint32(bytes, offset + 8),
    flags: readUint32(bytes, offset + 28),
  };
  validateFlashRange(entry, flashSize);
  return Object.freeze(entry);
}

function validateUniqueAndNonOverlapping(entries) {
  const labels = new Set();
  const ranges = [...entries].sort((left, right) => left.offset - right.offset || left.size - right.size);
  for (const entry of entries) {
    if (labels.has(entry.label)) fail(`duplicate partition label: ${entry.label}`);
    labels.add(entry.label);
  }
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (current.offset < previous.offset + previous.size) {
      fail(`partitions overlap: ${previous.label} and ${current.label}`);
    }
  }
}

function normalizedEntry(entry) {
  return {
    flags: entry.flags,
    label: entry.label,
    offset: entry.offset,
    size: entry.size,
    subtype: entry.subtype,
    type: entry.type,
  };
}

export function normalizePartitionEntries(entries) {
  if (!Array.isArray(entries)) fail("partition entries must be an array");
  return entries
    .map(normalizedEntry)
    .sort((left, right) => left.offset - right.offset || left.label.localeCompare(right.label));
}

export function semanticPartitionTableDigest(entries) {
  const normalized = normalizePartitionEntries(entries);
  const canonical = JSON.stringify(normalized);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function rawPartitionTableDigest(input) {
  assertBytes(input);
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Parse one complete ESP-IDF partition-table sector without shelling out.
 *
 * The parser intentionally accepts no format variants. The sector must be a
 * complete 0x1000-byte read with normal 32-byte entries, an optional ESP-IDF
 * MD5 entry, an all-FF terminator, and all-FF padding after the terminator.
 */
export function parseEspPartitionTable(input, { flashSize } = {}) {
  assertBytes(input);
  if (!Number.isSafeInteger(flashSize) || flashSize <= 0) {
    fail("target flash size is required");
  }

  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const entries = [];
  let tableDataEnd = 0;
  let md5Present = false;
  let terminated = false;
  let offset = 0;

  for (; offset < PARTITION_TABLE_DATA_SIZE; offset += PARTITION_ENTRY_SIZE) {
    if (isEndEntry(bytes, offset)) {
      terminated = true;
      tableDataEnd = offset;
      break;
    }

    if (isMd5Entry(bytes, offset)) {
      if (md5Present) fail("partition table contains more than one MD5 record");
      const expected = createHash("md5").update(bytes.subarray(0, offset)).digest();
      const observed = bytes.subarray(offset + 16, offset + PARTITION_ENTRY_SIZE);
      if (!equalBytes(expected, observed)) fail("partition table MD5 record does not match");
      md5Present = true;
      tableDataEnd = offset + PARTITION_ENTRY_SIZE;
      offset += PARTITION_ENTRY_SIZE;
      if (offset >= PARTITION_TABLE_DATA_SIZE || !isEndEntry(bytes, offset)) {
        fail("partition table MD5 record must be followed by an end record");
      }
      terminated = true;
      break;
    }

    entries.push(parseNormalEntry(bytes, offset, flashSize));
  }

  if (!terminated) fail("partition table is missing an all-FF end record");
  validateUniqueAndNonOverlapping(entries);

  const terminatorOffset = tableDataEnd === offset ? offset : tableDataEnd;
  const paddingStart = md5Present ? offset : tableDataEnd;
  for (let index = paddingStart + PARTITION_ENTRY_SIZE; index < PARTITION_TABLE_SIZE; index += 1) {
    if (bytes[index] !== 0xff) {
      fail(`partition table contains non-FF data after its terminal area at 0x${index.toString(16)}`);
    }
  }

  // The local variable documents the invariant for reviewers and keeps the
  // terminal entry validation explicit. It is not part of the semantic digest.
  if (!isEndEntry(bytes, terminatorOffset)) {
    fail("partition table terminal record is invalid");
  }

  const normalizedEntries = normalizePartitionEntries(entries).map((entry) => Object.freeze(entry));
  return Object.freeze({
    formatVersion: PARTITION_TABLE_FORMAT_VERSION,
    entries: Object.freeze(normalizedEntries),
    md5Present,
    rawSha256: rawPartitionTableDigest(bytes),
    semanticSha256: semanticPartitionTableDigest(normalizedEntries),
  });
}
