import type { CapabilitySchema } from "@tsx-lvgl/capabilities";
import { motionSchema } from "@tsx-lvgl/sensors";

/**
 * A boot-frozen allow-list for native capability payloads. The board transport
 * never imports an application-specific map, so a profile can add schemas by
 * constructing a registry before the kernel starts.
 */
export interface BoardSchemaRegistry {
  resolve(semanticId: string, version: number): CapabilitySchema<unknown> | undefined;
  list(): readonly CapabilitySchema<unknown>[];
}

export function createBoardSchemaRegistry(schemas: readonly CapabilitySchema<unknown>[]): BoardSchemaRegistry {
  const entries = new Map<string, CapabilitySchema<unknown>>();
  for (const schema of schemas) {
    if (!schema.id || !Number.isSafeInteger(schema.version) || schema.version <= 0) {
      throw new Error("board schema identity is invalid");
    }
    const key = `${schema.id}@${schema.version}`;
    if (entries.has(key)) throw new Error(`duplicate board schema: ${key}`);
    entries.set(key, Object.freeze(schema));
  }
  const frozen = Object.freeze([...entries.values()]);
  return Object.freeze({
    resolve: (semanticId: string, version: number) => entries.get(`${semanticId}@${version}`),
    list: () => frozen,
  });
}

export const DEFAULT_BOARD_SCHEMA_REGISTRY = createBoardSchemaRegistry([motionSchema]);
