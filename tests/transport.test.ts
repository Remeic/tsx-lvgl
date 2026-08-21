import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ACK_TIMEOUT_MS,
  COMMIT_TIMEOUT_MS,
  DATA_CHUNK_BASE64_LIMIT,
  buildBundleFrames,
  createPushSession,
  decodeBase64,
  encodeBase64,
  parseDeviceLine,
  type PushProgress,
} from "@tsx-lvgl/bundler";
import type { RuntimeBundleManifest } from "@tsx-lvgl/runtime";

const TEST_BOARD_ID = "tsx-lvgl.host-test";

function manifestWith(overrides: Partial<RuntimeBundleManifest> = {}): RuntimeBundleManifest {
  return {
    bundleId: "app",
    format: "js",
    engine: "quickjs-ng",
    protocolVersion: 1,
    boardId: TEST_BOARD_ID,
    generation: 5,
    sha256: "a".repeat(64),
    byteLength: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

test("encodeBase64 matches known RFC 4648 vectors", () => {
  assert.equal(encodeBase64(new Uint8Array()), "");
  assert.equal(encodeBase64(new TextEncoder().encode("f")), "Zg==");
  assert.equal(encodeBase64(new TextEncoder().encode("fo")), "Zm8=");
  assert.equal(encodeBase64(new TextEncoder().encode("foo")), "Zm9v");
});

test("decodeBase64 matches known RFC 4648 vectors", () => {
  assert.deepEqual([...decodeBase64("")], []);
  assert.deepEqual([...decodeBase64("Zg==")], [...new TextEncoder().encode("f")]);
  assert.deepEqual([...decodeBase64("Zm8=")], [...new TextEncoder().encode("fo")]);
  assert.deepEqual([...decodeBase64("Zm9v")], [...new TextEncoder().encode("foo")]);
});

test("encodeBase64/decodeBase64 round-trip every byte value 0..255", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const encoded = encodeBase64(bytes);
  assert.deepEqual([...decodeBase64(encoded)], [...bytes]);
});

test("decodeBase64 throws on an invalid character", () => {
  assert.throws(() => decodeBase64("Zg#="), /invalid character/);
  assert.throws(() => decodeBase64("!!!!"), /invalid character/);
});

test("decodeBase64 throws on bad padding", () => {
  assert.throws(() => decodeBase64("Zg=A"), /bad padding/);
  assert.throws(() => decodeBase64("A=BC"), /unexpected padding/);
  assert.throws(() => decodeBase64("AB=C"), /bad padding/);
  assert.throws(() => decodeBase64("Zg="), /multiple of 4/);
  assert.throws(() => decodeBase64("AB==CDEF"), /unexpected padding/);
});

test("encodeBase64 matches Buffer.from(...).toString('base64') for a fixed byte array", () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 254, 255, 127, 128]);
  assert.equal(encodeBase64(bytes), Buffer.from(bytes).toString("base64"));
  const full = Uint8Array.from({ length: 256 }, (_, index) => index);
  assert.equal(encodeBase64(full), Buffer.from(full).toString("base64"));
});

// ---------------------------------------------------------------------------
// buildBundleFrames
// ---------------------------------------------------------------------------

test("buildBundleFrames emits BEGIN and END 0 for an empty bundle", () => {
  const manifest = manifestWith({ byteLength: 0 });
  const frames = buildBundleFrames(manifest, new Uint8Array(0));
  assert.equal(frames.length, 2);
  assert.match(frames[0]!, /^TSXB BEGIN /);
  assert.equal(frames[1], "TSXB END 0");
});

test("buildBundleFrames emits exactly one DATA frame for one byte", () => {
  const manifest = manifestWith({ byteLength: 1 });
  const frames = buildBundleFrames(manifest, new Uint8Array([42]));
  assert.equal(frames.length, 3);
  assert.match(frames[1]!, /^TSXB DATA 1 /);
  assert.equal(frames[2], "TSXB END 1");
});

test("buildBundleFrames emits one DATA frame at exactly the chunk byte limit, two past it", () => {
  const maxChunkBytes = (DATA_CHUNK_BASE64_LIMIT / 4) * 3;
  const atLimit = new Uint8Array(maxChunkBytes);
  const overLimit = new Uint8Array(maxChunkBytes + 1);

  const atLimitFrames = buildBundleFrames(manifestWith({ byteLength: atLimit.length }), atLimit);
  assert.equal(atLimitFrames.length, 3);
  assert.equal(atLimitFrames[2], "TSXB END 1");

  const overLimitFrames = buildBundleFrames(manifestWith({ byteLength: overLimit.length }), overLimit);
  assert.equal(overLimitFrames.length, 4);
  assert.match(overLimitFrames[1]!, /^TSXB DATA 1 /);
  assert.match(overLimitFrames[2]!, /^TSXB DATA 2 /);
  assert.equal(overLimitFrames[3], "TSXB END 2");
});

test("buildBundleFrames keeps every DATA payload within the base64 limit with strictly increasing seq", () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 256);
  const manifest = manifestWith({ byteLength: bytes.length });
  const frames = buildBundleFrames(manifest, bytes);
  const dataFrames = frames.slice(1, frames.length - 1);
  const decodedChunks: number[] = [];
  assert.ok(dataFrames.length > 1);
  dataFrames.forEach((frame, index) => {
    const match = /^TSXB DATA (\d+) (\S*)$/.exec(frame);
    assert.ok(match, `frame did not match DATA shape: ${frame}`);
    assert.equal(Number(match![1]), index + 1);
    assert.ok(match![2]!.length <= DATA_CHUNK_BASE64_LIMIT);
    decodedChunks.push(...decodeBase64(match![2]!));
  });
  assert.deepEqual(Uint8Array.from(decodedChunks), bytes);
  assert.equal(frames[frames.length - 1], `TSXB END ${dataFrames.length}`);
});

test("buildBundleFrames BEGIN payload decodes to JSON.stringify(manifest)", () => {
  const manifest = manifestWith({ byteLength: 3, bundleId: "counter-5", generation: 9 });
  const frames = buildBundleFrames(manifest, new Uint8Array([1, 2, 3]));
  const payload = frames[0]!.slice("TSXB BEGIN ".length);
  const decoded = new TextDecoder().decode(decodeBase64(payload));
  assert.equal(decoded, JSON.stringify(manifest));
});

test("buildBundleFrames throws on a chunk limit that is not a positive multiple of 4", () => {
  const manifest = manifestWith({ byteLength: 1 });
  const bytes = new Uint8Array([1]);
  for (const limit of [0, -4, 3, 385, 1.5]) {
    assert.throws(() => buildBundleFrames(manifest, bytes, limit), /multiple of 4/);
  }
});

test("buildBundleFrames defaults chunkBase64Limit to DATA_CHUNK_BASE64_LIMIT", () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 256);
  const manifest = manifestWith({ byteLength: bytes.length });
  assert.deepEqual(buildBundleFrames(manifest, bytes), buildBundleFrames(manifest, bytes, DATA_CHUNK_BASE64_LIMIT));
});

// ---------------------------------------------------------------------------
// parseDeviceLine
// ---------------------------------------------------------------------------

test("parseDeviceLine parses a golden RDY line", () => {
  assert.deepEqual(
    parseDeviceLine(`TSXB RDY maxBytes=262144 protocol=1 board=${TEST_BOARD_ID} lastGeneration=3`),
    { kind: "rdy", maxBytes: 262144, protocol: 1, board: TEST_BOARD_ID, lastGeneration: 3 },
  );
});

test("parseDeviceLine parses a golden ACK line", () => {
  assert.deepEqual(parseDeviceLine("TSXB ACK 7"), { kind: "ack", seq: 7 });
});

test("parseDeviceLine parses a golden OK line", () => {
  assert.deepEqual(parseDeviceLine("TSXB OK bundle=counter-5 generation=6 epoch=2"), {
    kind: "ok",
    bundleId: "counter-5",
    generation: 6,
    epoch: 2,
  });
});

test("parseDeviceLine parses multi-digit values in every numeric field of RDY, ACK, and OK", () => {
  assert.deepEqual(
    parseDeviceLine(`TSXB RDY maxBytes=262144 protocol=12 board=b lastGeneration=34`),
    { kind: "rdy", maxBytes: 262144, protocol: 12, board: "b", lastGeneration: 34 },
  );
  assert.deepEqual(parseDeviceLine("TSXB ACK 12"), { kind: "ack", seq: 12 });
  assert.deepEqual(parseDeviceLine("TSXB OK bundle=app generation=12 epoch=34"), {
    kind: "ok",
    bundleId: "app",
    generation: 12,
    epoch: 34,
  });
});

test("parseDeviceLine's field regexes are anchored: leading noise before a field is rejected", () => {
  assert.deepEqual(
    parseDeviceLine("TSXB RDY xmaxBytes=1 protocol=1 board=b lastGeneration=0"),
    { kind: "noise", line: "TSXB RDY xmaxBytes=1 protocol=1 board=b lastGeneration=0" },
  );
  assert.deepEqual(parseDeviceLine("TSXB ACK x7"), { kind: "noise", line: "TSXB ACK x7" });
  assert.deepEqual(
    parseDeviceLine("TSXB OK xbundle=app generation=6 epoch=2"),
    { kind: "noise", line: "TSXB OK xbundle=app generation=6 epoch=2" },
  );
});

test("parseDeviceLine's field regexes are anchored: trailing noise after a field is rejected", () => {
  assert.deepEqual(parseDeviceLine("TSXB ACK 5x"), { kind: "noise", line: "TSXB ACK 5x" });
  assert.deepEqual(
    parseDeviceLine("TSXB RDY maxBytes=1 protocol=1 board=b lastGeneration=0x"),
    { kind: "noise", line: "TSXB RDY maxBytes=1 protocol=1 board=b lastGeneration=0x" },
  );
  assert.deepEqual(
    parseDeviceLine("TSXB OK bundle=app generation=6 epoch=2x"),
    { kind: "noise", line: "TSXB OK bundle=app generation=6 epoch=2x" },
  );
});

test("parseDeviceLine treats a line lacking the TSXB prefix as noise even when it looks like a frame after 5 chars", () => {
  // The first 5 characters ("12345") are not "TSXB ", so this must be noise;
  // a broken prefix check that unconditionally strips 5 characters would
  // instead see a valid "RDY maxBytes=..." remainder and misparse it.
  assert.deepEqual(
    parseDeviceLine("12345RDY maxBytes=1 protocol=1 board=b lastGeneration=0"),
    { kind: "noise", line: "12345RDY maxBytes=1 protocol=1 board=b lastGeneration=0" },
  );
});

test("parseDeviceLine's outer frame pattern is anchored to the start of the line", () => {
  // "TSXB " does appear in this line, just not at position 0; an unanchored
  // pattern would still find and misparse it as a real ACK frame.
  assert.deepEqual(parseDeviceLine("xTSXB ACK 7"), { kind: "noise", line: "xTSXB ACK 7" });
});

test("parseDeviceLine's outer frame pattern is anchored to the end of the line", () => {
  // An embedded newline can never occur in a real device line (the reader
  // already splits on "\n"), but the parser's own contract must still reject
  // it rather than silently truncate the remainder at the newline and parse
  // a partial frame.
  assert.deepEqual(
    parseDeviceLine("TSXB ACK 7\nEXTRA"),
    { kind: "noise", line: "TSXB ACK 7\nEXTRA" },
  );
});

test("parseDeviceLine parses a golden ERR line", () => {
  assert.deepEqual(parseDeviceLine("TSXB ERR sequence"), { kind: "err", reason: "sequence" });
});

test("parseDeviceLine trims a trailing carriage return", () => {
  assert.deepEqual(parseDeviceLine("TSXB ACK 7\r"), { kind: "ack", seq: 7 });
  assert.deepEqual(parseDeviceLine("random log line\r"), { kind: "noise", line: "random log line" });
});

test("parseDeviceLine treats a malformed RDY (missing field) as noise", () => {
  assert.deepEqual(parseDeviceLine(`TSXB RDY maxBytes=10 protocol=1 board=${TEST_BOARD_ID}`), {
    kind: "noise",
    line: `TSXB RDY maxBytes=10 protocol=1 board=${TEST_BOARD_ID}`,
  });
});

test("parseDeviceLine treats a non-numeric ACK seq as noise", () => {
  assert.deepEqual(parseDeviceLine("TSXB ACK abc"), { kind: "noise", line: "TSXB ACK abc" });
});

test("parseDeviceLine treats an unknown TSXB tag as noise", () => {
  assert.deepEqual(parseDeviceLine("TSXB FOO bar"), { kind: "noise", line: "TSXB FOO bar" });
});

test("parseDeviceLine treats an empty line as noise", () => {
  assert.deepEqual(parseDeviceLine(""), { kind: "noise", line: "" });
});

test("parseDeviceLine treats an unrelated log line as noise", () => {
  assert.deepEqual(parseDeviceLine("I (1234) wifi: connected"), {
    kind: "noise",
    line: "I (1234) wifi: connected",
  });
});

test("parseDeviceLine treats a bare tag with no remainder as noise", () => {
  assert.deepEqual(parseDeviceLine("TSXB RDY"), { kind: "noise", line: "TSXB RDY" });
  assert.deepEqual(parseDeviceLine("TSXB ACK"), { kind: "noise", line: "TSXB ACK" });
  // ERR's pattern (\S+) is far more permissive than RDY/ACK/OK's, so this
  // case alone catches a broken bare-tag/remainder split that RDY/ACK never
  // would: a bug that leaks the tag itself into the remainder would make
  // "ERR" match \S+ and misparse this as a device error.
  assert.deepEqual(parseDeviceLine("TSXB ERR"), { kind: "noise", line: "TSXB ERR" });
});

test("parseDeviceLine treats a malformed OK (missing field) as noise", () => {
  assert.deepEqual(parseDeviceLine("TSXB OK bundle=app generation=6"), {
    kind: "noise",
    line: "TSXB OK bundle=app generation=6",
  });
});

test("parseDeviceLine treats an ERR reason containing a space as noise", () => {
  assert.deepEqual(parseDeviceLine("TSXB ERR two words"), {
    kind: "noise",
    line: "TSXB ERR two words",
  });
});

// ---------------------------------------------------------------------------
// createPushSession
// ---------------------------------------------------------------------------

function rdyLine(overrides: Partial<{ maxBytes: number; protocol: number; board: string; lastGeneration: number }> = {}) {
  const fields = { maxBytes: 262144, protocol: 1, board: TEST_BOARD_ID, lastGeneration: 4, ...overrides };
  return `TSXB RDY maxBytes=${fields.maxBytes} protocol=${fields.protocol} board=${fields.board} lastGeneration=${fields.lastGeneration}`;
}

test("createPushSession happy path: BEGIN, RDY, ACKs, END, OK", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const expectedFrames = buildBundleFrames(manifest, bytes);
  const session = createPushSession(manifest, bytes);

  const begin = session.begin();
  assert.equal(begin.state, "awaiting-rdy");
  assert.deepEqual(begin.send, [expectedFrames[0]]);
  assert.equal(begin.acked, 0);
  assert.equal(begin.total, 1);

  const afterRdy = session.handle({ kind: "line", line: rdyLine() });
  assert.equal(afterRdy.state, "sending");
  assert.deepEqual(afterRdy.send, [expectedFrames[1]]);

  const afterAck = session.handle({ kind: "line", line: "TSXB ACK 1" });
  assert.equal(afterAck.state, "awaiting-commit");
  assert.equal(afterAck.acked, 1);
  assert.deepEqual(afterAck.send, [expectedFrames[2]]);

  const afterOk = session.handle({ kind: "line", line: "TSXB OK bundle=app generation=5 epoch=2" });
  const expected: PushProgress = {
    state: "done",
    send: [],
    acked: 1,
    total: 1,
    result: { generation: 5, epoch: 2 },
  };
  assert.deepEqual(afterOk, expected);
});

test("createPushSession happy path over multiple chunks acks each seq in order", () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 256);
  const manifest = manifestWith({ byteLength: bytes.length });
  const expectedFrames = buildBundleFrames(manifest, bytes);
  const total = expectedFrames.length - 2;
  assert.ok(total > 1, "fixture should require more than one chunk");

  const session = createPushSession(manifest, bytes);
  session.begin();
  let progress = session.handle({ kind: "line", line: rdyLine() });
  assert.equal(progress.state, "sending");

  for (let seq = 1; seq <= total; seq += 1) {
    progress = session.handle({ kind: "line", line: `TSXB ACK ${seq}` });
    if (seq < total) {
      assert.equal(progress.state, "sending");
      assert.deepEqual(progress.send, [expectedFrames[seq + 1]]);
    } else {
      assert.equal(progress.state, "awaiting-commit");
      assert.deepEqual(progress.send, [expectedFrames[total + 1]]);
    }
    assert.equal(progress.acked, seq);
  }

  progress = session.handle({ kind: "line", line: "TSXB OK bundle=app generation=5 epoch=3" });
  assert.equal(progress.state, "done");
  assert.deepEqual(progress.result, { generation: 5, epoch: 3 });
});

test("createPushSession empty-bundle path: BEGIN, RDY, END 0, OK", () => {
  const bytes = new Uint8Array(0);
  const manifest = manifestWith({ byteLength: 0 });
  const session = createPushSession(manifest, bytes);

  const begin = session.begin();
  assert.equal(begin.total, 0);

  const afterRdy = session.handle({ kind: "line", line: rdyLine() });
  assert.equal(afterRdy.state, "awaiting-commit");
  assert.deepEqual(afterRdy.send, ["TSXB END 0"]);

  const afterOk = session.handle({ kind: "line", line: "TSXB OK bundle=app generation=5 epoch=1" });
  assert.equal(afterOk.state, "done");
  assert.deepEqual(afterOk.result, { generation: 5, epoch: 1 });
});

test("createPushSession correlates OK identity and epoch with the sent manifest", () => {
  const bytes = new Uint8Array(0);
  const manifest = manifestWith({ byteLength: 0 });

  function receiveOk(line: string): PushProgress {
    const session = createPushSession(manifest, bytes);
    session.begin();
    session.handle({ kind: "line", line: rdyLine() });
    return session.handle({ kind: "line", line });
  }

  assert.equal(receiveOk("TSXB OK bundle=other generation=5 epoch=1").failure, "bundle mismatch");
  assert.equal(receiveOk("TSXB OK bundle=app generation=6 epoch=1").failure, "generation mismatch");
  assert.equal(receiveOk("TSXB OK bundle=app generation=5 epoch=0").failure, "invalid epoch");
  assert.equal(receiveOk("TSXB OK bundle=app generation=5 epoch=999999999999999999999999999999999999").failure, "invalid epoch");
  assert.deepEqual(receiveOk("TSXB OK bundle=app generation=5 epoch=1").result, { generation: 5, epoch: 1 });
});

test("createPushSession's snapshot omits failure and result keys on a non-terminal happy path", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  const begin = session.begin();
  assert.ok(!("failure" in begin), "a non-terminal snapshot must not carry a failure key");
  assert.ok(!("result" in begin), "a non-terminal snapshot must not carry a result key");

  const afterRdy = session.handle({ kind: "line", line: rdyLine() });
  assert.ok(!("failure" in afterRdy));
  assert.ok(!("result" in afterRdy));
});

test("createPushSession proceeds when RDY's maxBytes exactly equals the manifest byteLength", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const progress = session.handle({ kind: "line", line: rdyLine({ maxBytes: bytes.length }) });
  assert.equal(progress.state, "sending");
});

test("createPushSession's state is 'awaiting-rdy' even before begin() is called", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  const progress = session.handle({ kind: "timeout" });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "timeout in awaiting-rdy");
});

test("createPushSession rejects an RDY that reports too small a maxBytes", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const progress = session.handle({ kind: "line", line: rdyLine({ maxBytes: bytes.length - 1 }) });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "bundle exceeds device maxBytes");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession rejects an RDY with a mismatched protocol version", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length, protocolVersion: 1 });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const progress = session.handle({ kind: "line", line: rdyLine({ protocol: 2 }) });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "protocol mismatch");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession rejects an RDY with a mismatched board id", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const progress = session.handle({ kind: "line", line: rdyLine({ board: "other-board" }) });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "board mismatch");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession rejects an RDY reporting a non-monotonic generation", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length, generation: 5 });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const progress = session.handle({ kind: "line", line: rdyLine({ lastGeneration: 5 }) });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "generation not monotonic");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession fails on an ack received before any RDY", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const progress = session.handle({ kind: "line", line: "TSXB ACK 1" });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "unexpected ack 1");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession fails on an ack that skips ahead", () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 256);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  session.handle({ kind: "line", line: rdyLine() });
  const progress = session.handle({ kind: "line", line: "TSXB ACK 2" });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "unexpected ack 2");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession fails on a duplicate ack (gap of zero)", () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 256);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  session.handle({ kind: "line", line: rdyLine() });
  session.handle({ kind: "line", line: "TSXB ACK 1" });
  const progress = session.handle({ kind: "line", line: "TSXB ACK 1" });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "unexpected ack 1");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession fails when OK arrives before END (awaiting-rdy)", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const progress = session.handle({ kind: "line", line: "TSXB OK bundle=app generation=5 epoch=1" });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "protocol violation: OK before END");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession fails when OK arrives before END (sending)", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  session.handle({ kind: "line", line: rdyLine() });
  const progress = session.handle({ kind: "line", line: "TSXB OK bundle=app generation=5 epoch=1" });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "protocol violation: OK before END");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession fails on a device ERR mid-transfer and sends ABORT", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  session.handle({ kind: "line", line: rdyLine() });
  const progress = session.handle({ kind: "line", line: "TSXB ERR sequence" });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "device error: sequence");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession fails on a device ERR while awaiting RDY", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const progress = session.handle({ kind: "line", line: "TSXB ERR busy" });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "device error: busy");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession reports hardware reject reasons exactly and sends no data frame", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  for (const reason of ["hardware-mismatch", "hardware-unknown", "hardware-startup-failure"]) {
    const session = createPushSession(manifest, bytes);
    const begin = session.begin();
    assert.equal(begin.state, "awaiting-rdy");
    const rejected = session.handle({ kind: "line", line: `TSXB ERR ${reason}` });
    assert.equal(rejected.state, "failed");
    assert.equal(rejected.failure, `device error: ${reason}`);
    assert.deepEqual(rejected.send, ["TSXB ABORT"]);
    assert.equal(rejected.acked, 0);
  }
});

test("createPushSession times out while awaiting RDY", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const progress = session.handle({ kind: "timeout" });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "timeout in awaiting-rdy");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession times out while sending", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  session.handle({ kind: "line", line: rdyLine() });
  const progress = session.handle({ kind: "timeout" });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "timeout in sending");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession times out while awaiting commit", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  session.handle({ kind: "line", line: rdyLine() });
  session.handle({ kind: "line", line: "TSXB ACK 1" });
  const progress = session.handle({ kind: "timeout" });
  assert.equal(progress.state, "failed");
  assert.equal(progress.failure, "timeout in awaiting-commit");
  assert.deepEqual(progress.send, ["TSXB ABORT"]);
});

test("createPushSession ignores noise lines and preserves state", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const beforeNoise = session.handle({ kind: "line", line: rdyLine() });
  const afterNoise = session.handle({ kind: "line", line: "I (42) heap: free 100000" });
  assert.deepEqual(afterNoise, { ...beforeNoise, send: [] });
});

test("createPushSession ignores a stray RDY outside the handshake", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const beforeStrayRdy = session.handle({ kind: "line", line: rdyLine() });
  const afterStrayRdy = session.handle({ kind: "line", line: rdyLine() });
  assert.deepEqual(afterStrayRdy, { ...beforeStrayRdy, send: [] });
});

test("createPushSession ignores events after done", () => {
  const bytes = new Uint8Array(0);
  const manifest = manifestWith({ byteLength: 0 });
  const session = createPushSession(manifest, bytes);
  session.begin();
  session.handle({ kind: "line", line: rdyLine() });
  const done = session.handle({ kind: "line", line: "TSXB OK bundle=app generation=5 epoch=1" });
  assert.equal(done.state, "done");

  const afterTimeout = session.handle({ kind: "timeout" });
  assert.deepEqual(afterTimeout, { ...done, send: [] });
  const afterLine = session.handle({ kind: "line", line: "TSXB ERR busy" });
  assert.deepEqual(afterLine, { ...done, send: [] });
});

test("createPushSession ignores events after failed", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = manifestWith({ byteLength: bytes.length });
  const session = createPushSession(manifest, bytes);
  session.begin();
  const failed = session.handle({ kind: "line", line: "TSXB ERR busy" });
  assert.equal(failed.state, "failed");

  const afterTimeout = session.handle({ kind: "timeout" });
  assert.deepEqual(afterTimeout, { ...failed, send: [] });
  const afterLine = session.handle({ kind: "line", line: rdyLine() });
  assert.deepEqual(afterLine, { ...failed, send: [] });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("transport timing and chunk constants match the protocol spec", () => {
  assert.equal(DATA_CHUNK_BASE64_LIMIT, 384);
  assert.equal(ACK_TIMEOUT_MS, 1000);
  assert.equal(COMMIT_TIMEOUT_MS, 5000);
});
