import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PARTITION_ENTRY_SIZE,
  PARTITION_TABLE_SIZE,
  parseEspPartitionTable,
} from "../scripts/esp-partition-table.mjs";

const FLASH_SIZE = 0x1000000;

function putEntry(bytes, index, entry) {
  const offset = index * PARTITION_ENTRY_SIZE;
  bytes[offset] = 0xaa;
  bytes[offset + 1] = 0x50;
  bytes[offset + 2] = entry.type;
  bytes[offset + 3] = entry.subtype;
  bytes.writeUInt32LE(entry.offset, offset + 4);
  bytes.writeUInt32LE(entry.size, offset + 8);
  bytes.fill(0, offset + 12, offset + 28);
  bytes.write(entry.label, offset + 12, "utf8");
  bytes.writeUInt32LE(entry.flags ?? 0, offset + 28);
}

function makeTable(entries, { md5 = true } = {}) {
  const bytes = Buffer.alloc(PARTITION_TABLE_SIZE, 0xff);
  entries.forEach((entry, index) => putEntry(bytes, index, entry));
  const endIndex = entries.length;
  if (md5) {
    const md5Offset = endIndex * PARTITION_ENTRY_SIZE;
    bytes[md5Offset] = 0xeb;
    bytes[md5Offset + 1] = 0xeb;
    const digest = createHash("md5").update(bytes.subarray(0, md5Offset)).digest();
    digest.copy(bytes, md5Offset + 16);
  }
  return bytes;
}

function factoryEntries() {
  return [
    { label: "nvs", type: 1, subtype: 2, offset: 0x9000, size: 0x6000 },
    { label: "phy_init", type: 1, subtype: 1, offset: 0xf000, size: 0x1000 },
    { label: "factory", type: 0, subtype: 0, offset: 0x10000, size: 0x800000 },
  ];
}

test("valid V1 factory layout is parsed with immutable entries and a semantic digest", () => {
  const table = parseEspPartitionTable(makeTable(factoryEntries()), { flashSize: FLASH_SIZE });
  assert.equal(table.entries.find((entry) => entry.label === "factory").offset, 0x10000);
  assert.equal(table.md5Present, true);
  assert.match(table.rawSha256, /^[a-f0-9]{64}$/);
  assert.match(table.semanticSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(table), true);
  assert.equal(Object.isFrozen(table.entries[0]), true);
  assert.equal(
    parseEspPartitionTable(makeTable(factoryEntries(), { md5: false }), { flashSize: FLASH_SIZE }).semanticSha256,
    table.semanticSha256,
  );
});

test("issue-style stock layout is parsed with its observed application offset", () => {
  const table = parseEspPartitionTable(makeTable([
    { label: "nvs", type: 1, subtype: 2, offset: 0x9000, size: 0x6000 },
    { label: "otadata", type: 1, subtype: 0, offset: 0xf000, size: 0x2000 },
    { label: "ota_0", type: 0, subtype: 0x10, offset: 0x110000, size: 0x300000 },
    { label: "ota_1", type: 0, subtype: 0x11, offset: 0x410000, size: 0x300000 },
    { label: "assets", type: 1, subtype: 0x40, offset: 0x710000, size: 0x200000 },
    { label: "storage", type: 1, subtype: 0x81, offset: 0x910000, size: 0x6f0000 },
  ]), { flashSize: FLASH_SIZE });
  assert.equal(table.entries.find((entry) => entry.label === "ota_0").offset, 0x110000);
});

test("invalid magic, MD5, padding, terminator and truncation fail closed", () => {
  const invalidMagic = makeTable(factoryEntries());
  invalidMagic[0] = 0xab;
  assert.throws(() => parseEspPartitionTable(invalidMagic, { flashSize: FLASH_SIZE }), /magic/);

  const invalidMd5 = makeTable(factoryEntries());
  invalidMd5[112] ^= 0x01;
  assert.throws(() => parseEspPartitionTable(invalidMd5, { flashSize: FLASH_SIZE }), /MD5/);

  const invalidPadding = makeTable(factoryEntries());
  invalidPadding[(factoryEntries().length + 2) * PARTITION_ENTRY_SIZE + 3] = 0;
  assert.throws(() => parseEspPartitionTable(invalidPadding, { flashSize: FLASH_SIZE }), /non-FF/);

  const missingTerminatorEntries = Array.from({ length: 96 }, (_, index) => ({
    label: `p${index}`,
    type: 1,
    subtype: 0,
    offset: 0x10000 + index * 0x1000,
    size: 0x800,
  }));
  assert.throws(() => parseEspPartitionTable(makeTable(missingTerminatorEntries, { md5: false }), { flashSize: FLASH_SIZE }), /end record/);

  assert.throws(() => parseEspPartitionTable(new Uint8Array(PARTITION_TABLE_SIZE - 1), { flashSize: FLASH_SIZE }), /exactly/);
});

test("duplicate labels, overlaps and out-of-flash ranges fail closed", () => {
  const duplicate = makeTable([
    { label: "same", type: 1, subtype: 0, offset: 0x10000, size: 0x1000 },
    { label: "same", type: 1, subtype: 1, offset: 0x12000, size: 0x1000 },
  ]);
  assert.throws(() => parseEspPartitionTable(duplicate, { flashSize: FLASH_SIZE }), /duplicate/);

  const overlap = makeTable([
    { label: "a", type: 1, subtype: 0, offset: 0x10000, size: 0x3000 },
    { label: "b", type: 1, subtype: 1, offset: 0x12000, size: 0x1000 },
  ]);
  assert.throws(() => parseEspPartitionTable(overlap, { flashSize: FLASH_SIZE }), /overlap/);

  const outOfFlash = makeTable([
    { label: "too-big", type: 1, subtype: 0, offset: FLASH_SIZE - 0x1000, size: 0x2000 },
  ]);
  assert.throws(() => parseEspPartitionTable(outOfFlash, { flashSize: FLASH_SIZE }), /exceeds/);
});
