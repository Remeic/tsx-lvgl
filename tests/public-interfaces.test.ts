import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compileProject, type CompileConfig } from "@tsx-lvgl/compiler";
import { Screen as LegacyScreen } from "@tsx-lvgl/core";

const legacyConfig: CompileConfig = { root: () => LegacyScreen({}) };
const sourceConfig: CompileConfig = { entryFile: "examples/counter.tsx" };
void legacyConfig;
void sourceConfig;

// @ts-expect-error The public configuration is exclusive: root and entryFile cannot be combined.
const ambiguousConfig: CompileConfig = {
  root: () => LegacyScreen({}),
  entryFile: "examples/counter.tsx",
};
void ambiguousConfig;

// @ts-expect-error A config must select either a legacy root or a source entry.
const emptyConfig: CompileConfig = {};
void emptyConfig;

// @ts-expect-error Native IR emission is an internal compiler seam, not an emitter package API.
import type { emitNativeProgram } from "@tsx-lvgl/lvgl-emitter";

test("keeps the public compiler entry point narrow", () => {
  assert.equal(typeof compileProject, "function");
});
