import type { VNode } from "@tsx-lvgl/core";

/** Wire-protocol version for bundle manifests; single source of truth. */
export const PROTOCOL_VERSION = 1;

/** Mirrored by RUNTIME_BUNDLE_MAX_BYTES in the ESP-IDF host. */
export const RUNTIME_BUNDLE_MAX_BYTES = 262144;

export type RuntimeEngineName = "quickjs-ng" | "moddable-xs";

export interface RuntimeBundleManifest {
  readonly bundleId: string;
  readonly format: "js" | "bytecode";
  readonly engine: RuntimeEngineName;
  readonly protocolVersion: number;
  readonly boardId: string;
  readonly generation: number;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface RuntimeBundle {
  readonly manifest: RuntimeBundleManifest;
  readonly source: Uint8Array;
}

/**
 * The runtime does not depend on a concrete JavaScript engine. Board hosts
 * adapt QuickJS-NG (the first candidate) or another engine to this evaluator.
 */
export interface RuntimeEngine {
  readonly name: RuntimeEngineName;
  evaluate(source: Uint8Array, manifest: RuntimeBundleManifest): VNode;
}

export interface RuntimeBundlePolicy {
  readonly protocolVersion: number;
  readonly engine: RuntimeEngineName;
  readonly boardId: string;
  readonly maxBytes: number;
  readonly lastGeneration: number;
}

export type RuntimeBundleValidation =
  | { readonly ok: true; readonly bundle: RuntimeBundle }
  | { readonly ok: false; readonly reason: RuntimeBundleRejection };

export type RuntimeBundleRejection =
  | "empty-bundle-id"
  | "unsupported-format"
  | "engine-mismatch"
  | "protocol-mismatch"
  | "board-mismatch"
  | "generation-not-monotonic"
  | "invalid-hash"
  | "byte-length-mismatch"
  | "bundle-too-large";

/**
 * Validates the metadata before the transport hands bytes to an engine. Hash
 * computation and signature verification belong to the transport adapter; the
 * runtime still checks that the verified byte count matches the staged bytes.
 */
export function validateRuntimeBundle(
  bundle: RuntimeBundle,
  policy: RuntimeBundlePolicy,
): RuntimeBundleValidation {
  const { manifest, source } = bundle;
  if (manifest.bundleId.length === 0) return { ok: false, reason: "empty-bundle-id" };
  if (manifest.format !== "js" && manifest.format !== "bytecode") return { ok: false, reason: "unsupported-format" };
  if (manifest.engine !== policy.engine) return { ok: false, reason: "engine-mismatch" };
  if (manifest.protocolVersion !== policy.protocolVersion) return { ok: false, reason: "protocol-mismatch" };
  if (manifest.boardId !== policy.boardId) return { ok: false, reason: "board-mismatch" };
  if (!Number.isSafeInteger(manifest.generation) || manifest.generation <= policy.lastGeneration) {
    return { ok: false, reason: "generation-not-monotonic" };
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) return { ok: false, reason: "invalid-hash" };
  if (manifest.byteLength !== source.byteLength) return { ok: false, reason: "byte-length-mismatch" };
  if (source.byteLength > policy.maxBytes) return { ok: false, reason: "bundle-too-large" };
  return { ok: true, bundle: { manifest, source: source.slice() } };
}
