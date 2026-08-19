import { createHash } from "node:crypto";
import ts from "typescript";

import { PROTOCOL_VERSION, type RuntimeBundleManifest } from "@tsx-lvgl/runtime";

export { PROTOCOL_VERSION };

export interface BundleInput {
  /** Diagnostics only, never embedded in output. */
  readonly fileName: string;
  readonly source: string;
  readonly bundleId: string;
  readonly boardId: string;
  readonly generation: number;
  /** JSX runtime module used by the bundle; internal callers default to core. */
  readonly jsxImportSource?: string;
}

export interface BundleOutput {
  /** ASCII-only JS. */
  readonly code: string;
  /** Encoding of `code`; ASCII, so `bytes.byteLength === code.length`. */
  readonly bytes: Uint8Array;
  readonly manifest: RuntimeBundleManifest;
}

/**
 * Escapes every code unit >= 0x80 as a 4-digit uppercase `\uXXXX` sequence.
 * Surrogate pairs (astral characters) become two escapes, one per code unit.
 * Code units <= 0x7F (including 0x7F itself) pass through unchanged.
 */
export function escapeNonAscii(code: string): string {
  let result = "";
  // Stryker disable next-line AssignmentOperator: this is a bounded forward scan; decrementing the index cannot terminate.
  for (let index = 0; index < code.length; index += 1) {
    const unit = code.charCodeAt(index);
    if (unit <= 0x7f) {
      result += code[index];
    } else {
      result += `\\u${unit.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return result;
}

function assertValidBundleId(bundleId: string): void {
  if (bundleId.trim().length === 0) {
    throw new Error("compileTsxBundle: bundleId must not be empty or whitespace-only");
  }
}

function assertValidGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(`compileTsxBundle: generation must be a positive safe integer, got ${generation}`);
  }
}

export function compileTsxBundle(input: BundleInput): BundleOutput {
  assertValidBundleId(input.bundleId);
  assertValidGeneration(input.generation);

  const transpiled = ts.transpileModule(input.source, {
    fileName: input.fileName,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: input.jsxImportSource ?? "@tsx-lvgl/core",
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: true,
    },
  });

  if (transpiled.diagnostics && transpiled.diagnostics.length > 0) {
    // Stryker disable next-line StringLiteral: newline arg only affects DiagnosticMessageChain, which transpileModule's syntactic diagnostics never produce
    const flatten = (diagnostic: ts.Diagnostic): string => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const messages = transpiled.diagnostics.map(flatten).join("\n");
    throw new Error(`compileTsxBundle: TSX compilation failed:\n${messages}`);
  }

  const code = escapeNonAscii(transpiled.outputText);
  const bytes = new TextEncoder().encode(code);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const manifest: RuntimeBundleManifest = {
    bundleId: input.bundleId,
    format: "js",
    engine: "quickjs-ng",
    protocolVersion: PROTOCOL_VERSION,
    boardId: input.boardId,
    generation: input.generation,
    sha256,
    byteLength: bytes.byteLength,
  };

  return { code, bytes, manifest };
}

export {
  wrapCjsModule,
  renderKernelLoader,
  type KernelModule,
} from "./kernel.js";

export {
  DATA_CHUNK_BASE64_LIMIT,
  ACK_TIMEOUT_MS,
  COMMIT_TIMEOUT_MS,
  encodeBase64,
  decodeBase64,
  buildBundleFrames,
  parseDeviceLine,
  createPushSession,
  type DeviceLine,
  type PushEvent,
  type PushState,
  type PushProgress,
} from "./transport.js";
