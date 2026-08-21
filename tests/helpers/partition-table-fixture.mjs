const ENTRY_SIZE = 32;

/** Builds a padded 0x1000 ESP-IDF partition-table sector from entry objects. */
export function partitionTableFixture(entries) {
  const bytes = Buffer.alloc(0x1000, 0xff);
  entries.forEach((entry, index) => {
    const at = index * ENTRY_SIZE;
    bytes[at] = 0xaa;
    bytes[at + 1] = 0x50;
    bytes[at + 2] = entry.type;
    bytes[at + 3] = entry.subtype;
    bytes.writeUInt32LE(entry.offset, at + 4);
    bytes.writeUInt32LE(entry.size, at + 8);
    bytes.fill(0, at + 12, at + 28);
    bytes.write(entry.label, at + 12, "utf8");
  });
  return bytes;
}

export const V1_PARTITION_TABLE_ENTRIES = Object.freeze([
  { label: "nvs", type: 1, subtype: 2, offset: 0x9000, size: 0x6000 },
  { label: "phy_init", type: 1, subtype: 1, offset: 0xf000, size: 0x1000 },
  { label: "factory", type: 0, subtype: 0, offset: 0x10000, size: 0x800000 },
]);
