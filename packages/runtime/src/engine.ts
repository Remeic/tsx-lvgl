import { createVNode, isVNode, type Component, type VNode } from "@tsx-lvgl/core";
import type { RuntimeBundleManifest, RuntimeEngine, RuntimeEngineName } from "./bundle.js";

/**
 * Decodes a staged bundle's bytes as strict 7-bit ASCII source text. The
 * on-device engines (QuickJS-NG, Moddable XS) do not ship `TextDecoder`, and
 * ASCII-only keeps the transport, the hash, and the byte length all agreeing
 * on the same bytes with no encoding ambiguity.
 */
export function decodeAsciiSource(source: Uint8Array): string {
  // Stryker disable next-line ArrayDeclaration: preallocated length is a pure perf hint; every index 0..length-1 is assigned below, so a dynamically-grown array ends up byte-identical
  const chars: string[] = new Array(source.length);
  // Stryker disable next-line EqualityOperator, UpdateOperator: this is a bounded forward scan; reverse/over-broad mutations can only create a non-terminating loop.
  for (let index = 0; index < source.length; index++) {
    const byte = source[index]!;
    if (byte >= 0x80) throw new Error(`non-ascii byte at ${index}`);
    chars[index] = String.fromCharCode(byte);
  }
  return chars.join("");
}

/**
 * Maps a bundle's `require(specifier)` calls to the host's real module
 * namespaces. An unknown specifier is a bundle authoring error, so the
 * resolver throws rather than returning an empty module.
 */
export type ModuleResolver = (specifier: string) => Record<string, unknown>;

/**
 * Builds the CommonJS-shaped evaluator shared by every JavaScript engine
 * adapter: decode ASCII source, run it through `new Function` with a
 * `require`/`module`/`exports` seam, and resolve `module.exports.default`
 * into the VNode the runtime mounts.
 */
export function createProgramEngine(name: RuntimeEngineName, resolve: ModuleResolver): RuntimeEngine {
  return {
    name,
    evaluate(source: Uint8Array, _manifest: RuntimeBundleManifest): VNode {
      const code = decodeAsciiSource(source);
      const run = new Function("require", "module", "exports", code) as (
        require: ModuleResolver,
        module: { exports: Record<string, unknown> },
        exports: Record<string, unknown>,
      ) => void;
      const module: { exports: Record<string, unknown> } = { exports: {} };
      run(resolve, module, module.exports);

      const value = module.exports.default;
      if (typeof value === "function") return createVNode(value as Component);
      if (isVNode(value)) return value;
      throw new Error("bundle default export must be a component or VNode");
    },
  };
}
