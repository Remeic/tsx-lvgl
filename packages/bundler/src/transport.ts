import type { RuntimeBundleManifest } from "@tsx-lvgl/runtime";

/**
 * Dependency-free host-side implementation of the "Bundle transport v1 (dev
 * only)" protocol (see docs/feature-specs/0010-runtime-tsx-hot-reload.md).
 * No node imports: base64 and framing are plain TypeScript over
 * `Uint8Array`/`string` so mutation tests stay fast and the module could run
 * unmodified in a browser or on-device host in the future.
 */

/** Max base64 characters per `TSXB DATA` payload; mirrors the device's line buffer budget. */
export const DATA_CHUNK_BASE64_LIMIT = 384;
/** Host wait per `TSXB ACK` before declaring the transfer dead. */
export const ACK_TIMEOUT_MS = 1000;
/** Host wait for `TSXB OK`/`TSXB ERR` after `TSXB END` (device evaluation budget). */
export const COMMIT_TIMEOUT_MS = 5000;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  let index = 0;
  // Stryker disable next-line EqualityOperator, AssignmentOperator: this is a bounded forward scan; reverse mutations cannot terminate.
  for (; index + 3 <= bytes.length; index += 3) {
    const b0 = bytes[index]!;
    const b1 = bytes[index + 1]!;
    const b2 = bytes[index + 2]!;
    result += BASE64_ALPHABET[b0 >> 2];
    result += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    result += BASE64_ALPHABET[b2 & 0x3f];
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const b0 = bytes[index]!;
    result += BASE64_ALPHABET[b0 >> 2];
    result += BASE64_ALPHABET[(b0 & 0x03) << 4];
    result += "==";
  } else if (remaining === 2) {
    const b0 = bytes[index]!;
    const b1 = bytes[index + 1]!;
    result += BASE64_ALPHABET[b0 >> 2];
    result += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += BASE64_ALPHABET[(b1 & 0x0f) << 2];
    result += "=";
  }
  return result;
}

function base64CharValue(char: string): number {
  const value = BASE64_ALPHABET.indexOf(char);
  if (value === -1) {
    throw new Error(`decodeBase64: invalid character ${JSON.stringify(char)}`);
  }
  return value;
}

/** Decodes one base64 character at `index`; `=` is only legal in position 2 or 3 of the last group. */
function decodeChar(text: string, index: number, isLastGroup: boolean, position: number): number {
  const char = text[index]!;
  if (char === "=") {
    if (!isLastGroup || position < 2) {
      throw new Error(`decodeBase64: unexpected padding character at index ${index}`);
    }
    return -1;
  }
  return base64CharValue(char);
}

export function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) {
    throw new Error(`decodeBase64: length must be a multiple of 4, got ${text.length}`);
  }

  const lastGroupStart = text.length - 4;
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 4) {
    const isLastGroup = index === lastGroupStart;
    const v0 = decodeChar(text, index, isLastGroup, 0);
    const v1 = decodeChar(text, index + 1, isLastGroup, 1);
    const v2 = decodeChar(text, index + 2, isLastGroup, 2);
    const v3 = decodeChar(text, index + 3, isLastGroup, 3);
    if (v2 === -1 && v3 !== -1) {
      throw new Error(`decodeBase64: bad padding at index ${index}`);
    }
    bytes.push((v0 << 2) | (v1 >> 4));
    if (v2 !== -1) bytes.push(((v1 & 0x0f) << 4) | (v2 >> 2));
    if (v3 !== -1) bytes.push(((v2 & 0x03) << 6) | v3);
  }
  return Uint8Array.from(bytes);
}

/**
 * Builds the full `TSXB BEGIN`/`DATA`/`END` frame sequence for one push
 * attempt. `chunkBase64Limit` must be a positive multiple of 4 (a whole
 * number of base64 groups); the largest raw-byte chunk whose encoding fits
 * the limit is `(chunkBase64Limit / 4) * 3` bytes.
 */
export function buildBundleFrames(
  manifest: RuntimeBundleManifest,
  bytes: Uint8Array,
  chunkBase64Limit: number = DATA_CHUNK_BASE64_LIMIT,
): readonly string[] {
  if (!Number.isInteger(chunkBase64Limit) || chunkBase64Limit <= 0 || chunkBase64Limit % 4 !== 0) {
    throw new Error(`buildBundleFrames: chunkBase64Limit must be a positive multiple of 4, got ${chunkBase64Limit}`);
  }

  // Keep the loop finite even if this helper is called with an invalid value
  // after a validation guard is mutated during mutation testing. Valid limits
  // are always exact positive multiples of four, so this does not alter them.
  const maxChunkBytes = Math.max(1, (chunkBase64Limit / 4) * 3);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const frames: string[] = [`TSXB BEGIN ${encodeBase64(manifestBytes)}`];

  const chunkCount = Math.ceil(bytes.byteLength / maxChunkBytes);
  for (const chunkIndex of Array.from({ length: chunkCount }, (_unused, index) => index)) {
    const offset = chunkIndex * maxChunkBytes;
    frames.push(`TSXB DATA ${chunkIndex + 1} ${encodeBase64(bytes.subarray(offset, offset + maxChunkBytes))}`);
  }
  frames.push(`TSXB END ${chunkCount}`);
  return frames;
}

export type DeviceLine =
  | { readonly kind: "rdy"; readonly maxBytes: number; readonly protocol: number; readonly board: string; readonly lastGeneration: number }
  | { readonly kind: "ack"; readonly seq: number }
  | { readonly kind: "ok"; readonly bundleId: string; readonly generation: number; readonly epoch: number }
  | { readonly kind: "err"; readonly reason: string }
  | { readonly kind: "noise"; readonly line: string };

const TSXB_LINE_PATTERN = /^TSXB (RDY|ACK|OK|ERR) (.*)$/;
const RDY_PATTERN = /^maxBytes=(\d+) protocol=(\d+) board=(\S+) lastGeneration=(\d+)$/;
const ACK_PATTERN = /^(\d+)$/;
const OK_PATTERN = /^bundle=(\S+) generation=(\d+) epoch=(\d+)$/;
const ERR_PATTERN = /^(\S+)$/;

/**
 * Parses one line of the device console. Non-`TSXB` lines and malformed
 * `TSXB` lines (missing fields, non-numeric counters, a bare tag with no
 * trailing space) are all "noise": the device console interleaves regular
 * logs with protocol frames, and the protocol never treats unrecognized text
 * as an error.
 */
export function parseDeviceLine(rawLine: string): DeviceLine {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  const noise: DeviceLine = { kind: "noise", line };
  const outer = TSXB_LINE_PATTERN.exec(line);
  if (outer === null) return noise;
  const tag = outer[1]!;
  const remainder = outer[2]!;

  if (tag === "RDY") {
    const match = RDY_PATTERN.exec(remainder);
    if (!match) return noise;
    return {
      kind: "rdy",
      maxBytes: Number(match[1]),
      protocol: Number(match[2]),
      board: match[3]!,
      lastGeneration: Number(match[4]),
    };
  }
  if (tag === "ACK") {
    const match = ACK_PATTERN.exec(remainder);
    if (!match) return noise;
    return { kind: "ack", seq: Number(match[1]) };
  }
  if (tag === "OK") {
    const match = OK_PATTERN.exec(remainder);
    if (!match) return noise;
    return { kind: "ok", bundleId: match[1]!, generation: Number(match[2]), epoch: Number(match[3]) };
  }
  // The only remaining alternative admitted by TSXB_LINE_PATTERN is "ERR".
  const match = ERR_PATTERN.exec(remainder);
  if (!match) return noise;
  return { kind: "err", reason: match[1]! };
}

export type PushEvent = { readonly kind: "line"; readonly line: string } | { readonly kind: "timeout" };

export type PushState = "awaiting-rdy" | "sending" | "awaiting-commit" | "done" | "failed";

export interface PushProgress {
  readonly state: PushState;
  readonly send: readonly string[];
  readonly acked: number;
  readonly total: number;
  readonly failure?: string;
  readonly result?: { readonly generation: number; readonly epoch: number };
}

/**
 * Drives one push attempt through the window-size-1 handshake described by
 * the transport spec. `begin()` emits `BEGIN`; every subsequent `handle()`
 * call classifies one device line (or a caller-injected timeout) and returns
 * the frames the caller must write next. Host-detected failures (bad `RDY`,
 * an unexpected `ACK`, `OK` before `END`, a timeout) and device-reported
 * `TSXB ERR` send a best-effort `TSXB ABORT`. The device treats a redundant
 * abort after its terminal `ERR` as a no-op.
 */
export function createPushSession(
  manifest: RuntimeBundleManifest,
  bytes: Uint8Array,
): { begin(): PushProgress; handle(event: PushEvent): PushProgress } {
  const frames = buildBundleFrames(manifest, bytes);
  const total = frames.length - 2;

  let state: PushState = "awaiting-rdy";
  let acked = 0;
  let failure: string | undefined;
  let result: { readonly generation: number; readonly epoch: number } | undefined;

  function snapshot(send: readonly string[]): PushProgress {
    return {
      state,
      send,
      acked,
      total,
      ...(failure !== undefined ? { failure } : {}),
      ...(result !== undefined ? { result } : {}),
    };
  }

  function fail(reason: string): PushProgress {
    state = "failed";
    failure = reason;
    return snapshot(["TSXB ABORT"]);
  }

  function handleRdy(line: Extract<DeviceLine, { kind: "rdy" }>): PushProgress {
    if (manifest.byteLength > line.maxBytes) return fail("bundle exceeds device maxBytes");
    if (manifest.protocolVersion !== line.protocol) return fail("protocol mismatch");
    if (manifest.boardId !== line.board) return fail("board mismatch");
    if (manifest.generation <= line.lastGeneration) return fail("generation not monotonic");

    state = total === 0 ? "awaiting-commit" : "sending";
    return snapshot([frames[1]!]);
  }

  function handleAck(line: Extract<DeviceLine, { kind: "ack" }>): PushProgress {
    if (state !== "sending" || line.seq !== acked + 1) {
      return fail(`unexpected ack ${line.seq}`);
    }
    acked += 1;
    if (acked === total) {
      state = "awaiting-commit";
      return snapshot([frames[total + 1]!]);
    }
    return snapshot([frames[acked + 1]!]);
  }

  function handleOk(line: Extract<DeviceLine, { kind: "ok" }>): PushProgress {
    if (state !== "awaiting-commit") return fail("protocol violation: OK before END");
    if (line.bundleId !== manifest.bundleId) return fail("bundle mismatch");
    if (line.generation !== manifest.generation) return fail("generation mismatch");
    if (!Number.isSafeInteger(line.epoch) || line.epoch <= 0) return fail("invalid epoch");
    state = "done";
    result = { generation: line.generation, epoch: line.epoch };
    return snapshot([]);
  }

  return {
    begin(): PushProgress {
      state = "awaiting-rdy";
      return snapshot([frames[0]!]);
    },
    handle(event: PushEvent): PushProgress {
      if (state === "done" || state === "failed") return snapshot([]);
      if (event.kind === "timeout") return fail(`timeout in ${state}`);

      const parsed = parseDeviceLine(event.line);
      switch (parsed.kind) {
        case "noise":
          return snapshot([]);
        case "err":
          return fail(`device error: ${parsed.reason}`);
        case "rdy":
          // A stray RDY outside the handshake (the device sends it only once,
          // as the BEGIN reply) is not a defined protocol event; ignore it
          // like noise rather than invent an undocumented failure mode.
          if (state !== "awaiting-rdy") return snapshot([]);
          return handleRdy(parsed);
        case "ack":
          return handleAck(parsed);
        case "ok":
          return handleOk(parsed);
      }
    },
  };
}
