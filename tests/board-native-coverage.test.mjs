// Direct, hermetic unit coverage of the board transport (adapter, schema
// registry, runtime multiplexer, Wi-Fi service). These classes are also
// exercised end-to-end through tests/device.test.tsx and tests/e2e-host.test.tsx,
// but this file drives every branch directly against the compiled dist so the
// coverage gate does not depend on how much of the transport a rendered app
// happens to touch.
import assert from "node:assert/strict";
import test from "node:test";

import {
  BoardRuntime,
  MemoryBoardAdapter,
  NativeBoardWifiService,
  createBoardSchemaRegistry,
  createDefaultBoardDescriptors,
  decodeBoardPayload,
  encodeBoardPayload,
} from "../packages/device/dist/index.js";
import { motionSchema } from "../packages/sensors/dist/index.js";
import { WIFI_MAX_PENDING_COMMANDS } from "../packages/connectivity/dist/index.js";

const motion = createDefaultBoardDescriptors()[0];
const frame = { accelerationMps2: [0, 0, 9.80665], angularVelocityDps: [0, 0, 0] };
const numberSchema = { id: "test.number", version: 1, validate: (value) => typeof value === "number" };
const numberDescriptor = { ...motion, familyCode: 0x0102, semanticId: numberSchema.id, instanceId: "number", source: "fixture" };
const context = { reloadEpoch: 1, isCancelled: () => false };

class FailingBoardAdapter extends MemoryBoardAdapter {
  failAtSubmission;
  submit(request) {
    if (this.failAtSubmission === this.submitted.length + 1) throw new Error("submit failed");
    return super.submit(request);
  }
}

// ---------------------------------------------------------------------------
// board-adapter.js
// ---------------------------------------------------------------------------

test("encodeBoardPayload/decodeBoardPayload round-trip and reject non-ASCII / malformed / non-object payloads", () => {
  const encoded = encodeBoardPayload({ status: "ok", value: 1 });
  assert.deepEqual(decodeBoardPayload(encoded), { status: "ok", value: 1 });
  assert.throws(() => encodeBoardPayload({ value: "café" }), /board payload must be ASCII/);
  assert.equal(decodeBoardPayload(Uint8Array.from([0xff])), undefined, "byte > 0x7f is rejected before JSON.parse");
  assert.equal(decodeBoardPayload(Uint8Array.from("not json", (c) => c.charCodeAt(0))), undefined, "malformed JSON is caught and redacted");
  assert.equal(decodeBoardPayload(Uint8Array.from("[1,2]", (c) => c.charCodeAt(0))), undefined, "a JSON array is not a valid payload shape");
  assert.equal(decodeBoardPayload(Uint8Array.from("null", (c) => c.charCodeAt(0))), undefined, "a JSON null is not a valid payload shape");
});

test("MemoryBoardAdapter tracks active handles, disposes once, and rejects post-dispose calls", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion], cached: new Map([["motion", { version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 0, payload: encodeBoardPayload({ status: "ok" }) }]]) });
  assert.deepEqual(adapter.readCached("motion"), { version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 0, payload: encodeBoardPayload({ status: "ok" }) });
  assert.equal(adapter.readCached("missing"), undefined);
  const handle = adapter.submit({ version: 1, kind: "observe", instanceId: "motion", periodMs: 80, reloadEpoch: 1 });
  assert.equal(adapter.activeHandleCount(), 1);
  adapter.cancel(handle);
  adapter.cancel(handle);
  assert.deepEqual(adapter.cancelled, [handle], "cancelling an already-cancelled handle is a no-op");
  assert.equal(adapter.activeHandleCount(), 0);
  const secondHandle = adapter.submit({ version: 1, kind: "observe", instanceId: "motion", periodMs: 80, reloadEpoch: 1 });
  let sunk;
  adapter.setSink((event) => { sunk = event; });
  adapter.emit({ version: 1, kind: "state", handle: secondHandle, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok" }) });
  assert.equal(sunk.sequence, 1);
  adapter.emit({ version: 1, kind: "state", handle: 999, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok" }) });
  assert.equal(sunk.sequence, 1, "an event for an unknown handle is dropped, not delivered");
  adapter.dispose();
  adapter.emit({ version: 1, kind: "state", handle: secondHandle, reloadEpoch: 1, sequence: 2, observedAtMs: 2, payload: encodeBoardPayload({ status: "ok" }) });
  assert.equal(sunk.sequence, 1, "emit after dispose is a no-op");
  assert.throws(() => adapter.submit({ version: 1, kind: "observe", instanceId: "motion", periodMs: 80, reloadEpoch: 1 }), /board adapter is disposed/);
  assert.throws(() => adapter.setSink(() => undefined), /board adapter is disposed/);
});

// ---------------------------------------------------------------------------
// board-schema-registry.js
// ---------------------------------------------------------------------------

test("createBoardSchemaRegistry rejects invalid or duplicate schema identity and freezes its entries", () => {
  assert.throws(() => createBoardSchemaRegistry([{ id: "", version: 1, validate: () => true }]), /board schema identity is invalid/);
  assert.throws(() => createBoardSchemaRegistry([{ id: "x", version: 0, validate: () => true }]), /board schema identity is invalid/);
  assert.throws(() => createBoardSchemaRegistry([{ id: "x", version: 1.5, validate: () => true }]), /board schema identity is invalid/);
  assert.throws(() => createBoardSchemaRegistry([motionSchema, motionSchema]), /duplicate board schema/);
  const registry = createBoardSchemaRegistry([motionSchema, numberSchema]);
  assert.equal(Object.isFrozen(registry.list()), true);
  assert.equal(registry.list().length, 2);
  assert.equal(registry.resolve(motionSchema.id, motionSchema.version), motionSchema);
  assert.equal(registry.resolve("unknown", 1), undefined);
});

// ---------------------------------------------------------------------------
// board-runtime.js
// ---------------------------------------------------------------------------

test("BoardRuntime rejects a duplicate native descriptor for the same schema", () => {
  const duplicate = { ...motion };
  assert.throws(() => new BoardRuntime(new MemoryBoardAdapter({ descriptors: [motion, duplicate] })), /duplicate native capability descriptor/);
});

test("BoardRuntime rejects a native descriptor with invalid identity or invalid bounds at boot", () => {
  assert.throws(() => new BoardRuntime(new MemoryBoardAdapter({ descriptors: [{ ...motion, familyCode: 0 }] })), /capability descriptor identity is invalid/);
  assert.throws(() => new BoardRuntime(new MemoryBoardAdapter({ descriptors: [{ ...motion, instanceId: "" }] })), /capability descriptor identity is invalid/);
  assert.throws(() => new BoardRuntime(new MemoryBoardAdapter({ descriptors: [{ ...motion, maxFrameBytes: 0 }] })), /capability descriptor bounds are invalid/);
  assert.throws(() => new BoardRuntime(new MemoryBoardAdapter({ descriptors: [{ ...motion, defaultPeriodMs: motion.minPeriodMs - 1 }] })), /capability descriptor bounds are invalid/);
});

test("BoardRuntime silently skips a native descriptor whose schema is not registered", () => {
  // A schema registry that only knows about motion; a descriptor for a different,
  // unregistered semantic ID must be catalogued as absent rather than throwing.
  const registry = createBoardSchemaRegistry([motionSchema]);
  const mystery = { ...motion, familyCode: 0x0109, semanticId: "mystery.unregistered", instanceId: "mystery" };
  const adapter = new MemoryBoardAdapter({ descriptors: [motion, mystery] });
  assert.doesNotThrow(() => new BoardRuntime(adapter, { registry }));
});

test("BoardRuntime.getBinding resolves an un-subscribed but cached reading, and treats a malformed cached event as absent", () => {
  const goodCached = new Map([["motion", { version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 0, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame, droppedSincePrevious: 0 }) }]]);
  const adapter = new MemoryBoardAdapter({ descriptors: [motion], cached: goodCached });
  const board = new BoardRuntime(adapter);
  assert.equal(board.getBinding(motionSchema).state.status, "ready", "no producer yet, but the adapter's cache resolves through readCached");
  board.dispose();

  const badCached = new Map([["motion", { version: 1, kind: "state", handle: 1, reloadEpoch: 0, sequence: 1, observedAtMs: 0, payload: encodeBoardPayload({ status: "ok" }) }]]);
  const board2 = new BoardRuntime(new MemoryBoardAdapter({ descriptors: [motion], cached: badCached }));
  assert.equal(board2.getBinding(motionSchema).state.status, "starting", "reloadEpoch <= 0 fails isCachedEventValid, so the cache is treated as absent");
  board2.dispose();
});

test("BoardRuntime.getBinding reports ambiguous for multiple non-default instances and unsupported for an unknown instanceId", () => {
  const registry = createBoardSchemaRegistry([motionSchema, numberSchema]);
  const instanceA = { ...numberDescriptor, instanceId: "num-a", isDefault: false };
  const instanceB = { ...numberDescriptor, instanceId: "num-b", isDefault: false };
  const board = new BoardRuntime(new MemoryBoardAdapter({ descriptors: [instanceA, instanceB] }), { registry });
  assert.equal(board.getBinding(numberSchema).state.status, "ambiguous", "two non-default instances and no instanceId selects nothing");
  assert.equal(board.getBinding(numberSchema, { instanceId: "does-not-exist" }).state.status, "unsupported");
  board.dispose();
});

test("BoardRuntime.getBinding reports unsupported/not-present for a schema with zero registered descriptors", () => {
  const registry = createBoardSchemaRegistry([motionSchema, numberSchema]);
  const board = new BoardRuntime(new MemoryBoardAdapter({ descriptors: [motion] }), { registry });
  const binding = board.getBinding(numberSchema);
  assert.equal(binding.state.status, "unsupported");
  assert.equal(binding.state.reason, "not-present", "instances() falls back to [] when the schema id was never registered");
  board.dispose();
});

test("BoardRuntime.subscribe short-circuits when disabled, unsupported, or ambiguous, and its no-op cancel is callable", () => {
  const registry = createBoardSchemaRegistry([motionSchema, numberSchema]);
  const instanceA = { ...numberDescriptor, instanceId: "num-a", isDefault: false };
  const instanceB = { ...numberDescriptor, instanceId: "num-b", isDefault: false };
  const board = new BoardRuntime(new MemoryBoardAdapter({ descriptors: [motion, instanceA, instanceB] }), { registry });

  const disabled = board.subscribe(motionSchema, { enabled: false }, context, () => undefined);
  assert.doesNotThrow(() => disabled.cancel());

  const unsupported = board.subscribe(numberSchema, { instanceId: "missing" }, context, () => undefined);
  assert.doesNotThrow(() => unsupported.cancel());

  const ambiguous = board.subscribe(numberSchema, {}, context, () => undefined);
  assert.doesNotThrow(() => ambiguous.cancel());

  assert.equal(board.diagnostics().activeOwners.length, 0, "none of these ever created a producer");
  board.dispose();
});

test("BoardRuntime.subscribe defends against onState mutating the shared options object mid-call", () => {
  // getBinding() and the later selectedInstance() re-check both read options.instanceId.
  // If a caller's onState callback mutates `options` synchronously in between (misuse of
  // the API, but not prevented by the type system), the second read must be able to
  // disagree with the first — this is the defensive branch that guards against exactly
  // that reentrant mutation.
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  const options = {};
  const sub = board.subscribe(motionSchema, options, context, () => {
    options.instanceId = "does-not-exist";
  });
  assert.doesNotThrow(() => sub.cancel());
  assert.equal(board.diagnostics().activeOwners.length, 0, "no producer was created for the aborted subscription");
  board.dispose();
});

test("BoardRuntime.subscribe defends against a schema whose id is not stable across the call (descriptor re-lookup guard)", () => {
  // this.descriptors.get(schema.id) is re-read a third time, independently of the two
  // earlier instances()-driven reads that already established a selected instance. All
  // three reads are against the same immutable, boot-populated map, so in practice they
  // can never disagree — unless the schema object itself lies about its own id.
  const registry = createBoardSchemaRegistry([motionSchema]);
  const board = new BoardRuntime(new MemoryBoardAdapter({ descriptors: [motion] }), { registry });
  let reads = 0;
  const flakySchema = {
    version: motionSchema.version,
    validate: motionSchema.validate,
    get id() {
      reads += 1;
      return reads <= 2 ? motionSchema.id : "id-that-does-not-exist";
    },
  };
  assert.throws(() => board.subscribe(flakySchema, {}, context, () => undefined));
  board.dispose();
});

test("BoardRuntime cancelling an already-cancelled subscription is a no-op", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  const sub = board.subscribe(motionSchema, {}, context, () => undefined);
  sub.cancel();
  assert.doesNotThrow(() => sub.cancel());
  board.dispose();
});

test("BoardRuntime.handleEvent routes a Wi-Fi station event to the Wi-Fi service instead of treating it as a capability reading", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  board.subscribe(motionSchema, {}, context, () => undefined); // handle 1, makes handle 1 active at the adapter
  adapter.emit({ version: 1, kind: "state", instanceId: "wifi.station", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", value: { phase: "idle" } }) });
  assert.equal(board.diagnostics().droppedEvents, 0, "the Wi-Fi service accepted it; BoardRuntime never saw it as a rejected envelope");
  board.dispose();
});

test("BoardRuntime.handleEvent rejects a non-state event, an event for an unknown handle, and an event whose reloadEpoch does not match the producer", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  board.subscribe(motionSchema, {}, context, () => undefined); // handle 1
  board.wifi.connect(context); // handle 2, active at the adapter but not a board producer handle

  adapter.emit({ version: 1, kind: "operation", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "succeeded", correlationId: "x" }) });
  assert.equal(board.diagnostics().droppedEvents, 1, "kind !== state is rejected as board-envelope");

  adapter.emit({ version: 1, kind: "state", handle: 2, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok" }) });
  assert.equal(board.diagnostics().droppedEvents, 2, "a handle with no board producer is rejected as board-envelope");

  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 999, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame, droppedSincePrevious: 0 }) });
  assert.equal(board.diagnostics().droppedEvents, 3, "a reloadEpoch mismatch fails isEventValid and is rejected as board-envelope");
  board.dispose();
});

test("BoardRuntime.handleEvent rejects a stale/duplicate sequence and a reading that fails to decode", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  board.subscribe(motionSchema, {}, context, () => undefined);
  board.commitEpoch(1);
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 5, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame, droppedSincePrevious: 0 }) });
  assert.equal(board.diagnostics().droppedEvents, 0);

  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 5, observedAtMs: 2, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame, droppedSincePrevious: 0 }) });
  assert.equal(board.diagnostics().droppedEvents, 1, "sequence <= lastSequence is rejected as board-sequence");

  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 6, observedAtMs: 3, payload: encodeBoardPayload({ status: "ok", schemaVersion: 999, value: frame, droppedSincePrevious: 0 }) });
  assert.equal(board.diagnostics().droppedEvents, 2, "a schemaVersion mismatch fails decodeReading and is rejected as board-reading");

  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 7, observedAtMs: 4, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: { not: "a motion frame" }, droppedSincePrevious: 0 }) });
  assert.equal(board.diagnostics().droppedEvents, 3, "schema.validate() rejects a malformed value and decodeReading returns undefined");

  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 8, observedAtMs: 5, payload: encodeBoardPayload({ status: "error", schemaVersion: 1, droppedSincePrevious: 0 }) });
  assert.equal(board.diagnostics().droppedEvents, 4, "an error status with no issue object at all fails and is rejected as board-reading");

  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 9, observedAtMs: 6, payload: encodeBoardPayload({ status: "error", schemaVersion: 1, issue: { code: "not-a-real-code", retry: "never", diagnosticId: "x" }, droppedSincePrevious: 0 }) });
  assert.equal(board.diagnostics().droppedEvents, 5, "an invalid issue shape fails isBoardIssue and is rejected as board-reading");

  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 10, observedAtMs: 7, payload: encodeBoardPayload({ status: "stale", schemaVersion: 1, value: frame, droppedSincePrevious: 0 }) });
  assert.equal(board.diagnostics().droppedEvents, 5, "a well-formed stale reading decodes successfully");
  assert.equal(board.getBinding(motionSchema).state.status, "stale");
  board.dispose();
});

test("BoardRuntime.handleEvent rejects delivery once queued subscribers exceed the queue budget", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter, { limits: { maxQueuedDeliveries: 1 } });
  board.subscribe(motionSchema, {}, context, () => undefined);
  board.subscribe(motionSchema, {}, context, () => undefined);
  board.commitEpoch(1);
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame, droppedSincePrevious: 0 }) });
  assert.equal(board.diagnostics().droppedEvents, 1, "2 active subscribers exceeds a maxQueuedDeliveries of 1");
  board.dispose();
});

test("BoardRuntime.handleEvent ignores an event delivered after dispose", () => {
  // BoardRuntime.dispose() synchronously disposes its adapter right after flipping its own
  // `disposed` flag, so there is no natural window where a real adapter still delivers to
  // a disposed BoardRuntime. This captures the sink registered via the legitimate
  // setSink() integration point and re-invokes it directly to exercise that guard.
  class SinkCapturingAdapter extends MemoryBoardAdapter {
    capturedSink;
    setSink(sink) {
      this.capturedSink = sink;
      super.setSink(sink);
    }
  }
  const adapter = new SinkCapturingAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  board.dispose();
  assert.doesNotThrow(() => adapter.capturedSink({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok" }) }));
});

test("BoardRuntime.asState defends against a Reading that carries both a value and an issue", () => {
  // decodeReading() never produces a Reading with both `value` and `issue` set — the
  // "ok"/"stale" branch always sets value only, and the issue branch never sets value.
  // This is a documented invariant, not a public code path; asState is invoked directly
  // to exercise the `last` fallback that would otherwise be permanently dead.
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  const reading = { status: "error", value: { some: "value" }, issue: { code: "internal", retry: "never", diagnosticId: "x" }, observedAtMs: 1, sequence: 1, droppedSincePrevious: 0 };
  const state = board.asState(reading);
  assert.deepEqual(state.last, { value: reading.value, observedAtMs: 1, sequence: 1, droppedSincePrevious: 0 });
  board.dispose();
});

test("BoardRuntime rejects a subscriber once the global subscriber budget is exhausted", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter, { limits: { maxSubscribers: 1 } });
  board.subscribe(motionSchema, {}, context, () => undefined);
  let limited;
  const rejected = board.subscribe(motionSchema, {}, context, (binding) => { if (binding.state.status === "unavailable") limited = binding.state.issue.diagnosticId; });
  assert.equal(limited, "board-subscriber-budget");
  assert.equal(board.diagnostics().resourceUse.subscriberBudget, 1);
  assert.doesNotThrow(() => rejected.cancel(), "the rejected subscription's no-op cancel is itself callable");
  board.dispose();
});

test("BoardRuntime constructor rejects a non-positive or non-integer resource limit", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  assert.throws(() => new BoardRuntime(adapter, { limits: { maxObservers: 0 } }), /board resource limit must be positive/);
});

test("BoardRuntime.subscribe falls back to the descriptor's default period for an invalid requested period", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  board.subscribe(motionSchema, { periodMs: -5 }, context, () => undefined);
  assert.equal(board.diagnostics().effectivePeriodsMs.motion, motion.defaultPeriodMs, "a non-positive requested period is not a safe integer bound, so boundPeriod falls back to the descriptor default");
  board.dispose();
});

test("BoardRuntime enforces the observer budget across producers and the subscriber budget across all producers", () => {
  const registry = createBoardSchemaRegistry([motionSchema, numberSchema]);
  const adapter = new MemoryBoardAdapter({ descriptors: [motion, numberDescriptor] });
  const board = new BoardRuntime(adapter, { registry, limits: { maxObservers: 1 } });
  board.subscribe(motionSchema, {}, context, () => undefined);
  const states = [];
  board.subscribe(numberSchema, {}, context, (binding) => states.push(binding.state.status));
  assert.deepEqual(states, ["starting", "unavailable"]);
  assert.equal(board.diagnostics().resourceUse.observers, 1);
  board.dispose();
});

test("BoardRuntime.diagnostics reports periods, queue high-water, dropped events and active owners", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  board.subscribe(motionSchema, { periodMs: 80 }, context, () => undefined);
  board.commitEpoch(1);
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame, droppedSincePrevious: 0 }) });
  const diagnostics = board.diagnostics();
  assert.deepEqual(diagnostics.effectivePeriodsMs, { motion: 80 });
  assert.deepEqual(diagnostics.activeOwners, ["motion"]);
  assert.equal(diagnostics.queueDepth, 0);
  assert.equal(diagnostics.queueHighWater, 1);
  assert.equal(diagnostics.droppedEvents, 0);
  assert.equal(diagnostics.resourceUse.subscribers, 1);
  assert.equal("lastIssue" in diagnostics, false, "no issue yet means the optional field is omitted");
  board.dispose();
});

test("BoardRuntime.commitEpoch rolls back every staged submission when one native submit throws", () => {
  const registry = createBoardSchemaRegistry([motionSchema, numberSchema]);
  const adapter = new FailingBoardAdapter({ descriptors: [motion, numberDescriptor] });
  const board = new BoardRuntime(adapter, { registry });
  board.subscribe(motionSchema, {}, context, () => undefined);
  board.subscribe(numberSchema, {}, context, () => undefined);
  board.commitEpoch(1);
  // Let the first producer's re-submit for epoch 2 succeed (staged into `pending`) and
  // fail the second, so the catch handler's unwind loop has something to cancel.
  adapter.failAtSubmission = adapter.submitted.length + 2;
  assert.throws(() => board.commitEpoch(2), /submit failed/);
  assert.equal(adapter.cancelled.length, 1, "the one staged submit before the failure is unwound, not left dangling");
  board.dispose();
});

test("BoardRuntime.commitEpoch ignores a non-positive epoch or one already committed", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  board.subscribe(motionSchema, {}, context, () => undefined);
  assert.doesNotThrow(() => board.commitEpoch(0));
  board.commitEpoch(1);
  assert.equal(adapter.submitted.length, 1, "epoch 1 matches the producer's own reloadEpoch, so no re-submit happens");
  assert.doesNotThrow(() => board.commitEpoch(1), "epoch <= committedEpoch is a no-op");
  board.dispose();
});

test("BoardRuntime.rollbackEpoch tears down a producer staged under a rejected epoch", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  const staged = { reloadEpoch: 5, isCancelled: () => false };
  board.subscribe(motionSchema, {}, staged, () => undefined);
  const handle = adapter.submitted.length;
  board.rollbackEpoch(5);
  assert.deepEqual(adapter.cancelled, [handle]);
  assert.equal(board.diagnostics().activeOwners.length, 0);
  // A no-op rollback for an epoch already committed or never staged does not touch the adapter.
  board.rollbackEpoch(5);
  assert.deepEqual(adapter.cancelled, [handle]);
  board.dispose();
});

test("BoardRuntime.rollbackEpoch ignores an invalid epoch, a producer staged under a different epoch, and an epoch already committed", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  assert.doesNotThrow(() => board.rollbackEpoch(0), "not a positive safe integer is a no-op");

  board.subscribe(motionSchema, {}, context, () => undefined); // context.reloadEpoch = 1
  board.rollbackEpoch(2); // producer.reloadEpoch (1) !== 2, so this producer is skipped, not torn down
  assert.equal(board.diagnostics().activeOwners.length, 1);

  board.commitEpoch(1); // committedEpoch = 1
  board.rollbackEpoch(1); // reloadEpoch === epoch, but epoch <= committedEpoch: too late to roll back
  assert.equal(board.diagnostics().activeOwners.length, 1);
  board.dispose();
});

test("BoardRuntime.expire delegates to the Wi-Fi service", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  assert.doesNotThrow(() => board.expire());
  board.dispose();
});

test("BoardRuntime.dispose cancels every producer, disposes Wi-Fi and the adapter, and is idempotent", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  board.subscribe(motionSchema, {}, context, () => undefined);
  const handle = adapter.submitted.length;
  board.dispose();
  assert.deepEqual(adapter.cancelled, [handle]);
  assert.equal(board.diagnostics().activeOwners.length, 0);
  board.dispose();
  assert.deepEqual(adapter.cancelled, [handle], "a second dispose does not double-cancel");
});

test("BoardRuntime.deliver forwards both value-bearing and issue-bearing events to onEvent", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  const events = [];
  board.subscribe(motionSchema, {}, context, () => undefined, (event) => events.push(event));
  board.commitEpoch(1);
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame, droppedSincePrevious: 2 }) });
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 2, observedAtMs: 2, payload: encodeBoardPayload({ status: "error", schemaVersion: 1, issue: { code: "internal", retry: "never", diagnosticId: "sensor-fault" } }) });
  assert.equal(events.length, 2);
  assert.equal(events[0].status, "ok");
  assert.deepEqual(events[0].value, frame);
  assert.equal("issue" in events[0], false);
  assert.equal(events[1].status, "error");
  assert.equal("value" in events[1], false);
  assert.deepEqual(events[1].issue, { code: "internal", retry: "never", diagnosticId: "sensor-fault" });
  board.dispose();
});

test("BoardRuntime recomputes the native cadence as subscribers with different periods join and leave", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  const slow = board.subscribe(motionSchema, { periodMs: 80 }, context, () => undefined);
  const fast = board.subscribe(motionSchema, { periodMs: 20 }, context, () => undefined);
  assert.deepEqual(adapter.submitted.map((request) => request.periodMs), [80, 20]);
  assert.equal(board.diagnostics().effectivePeriodsMs.motion, 20);
  fast.cancel();
  assert.equal(board.diagnostics().effectivePeriodsMs.motion, 80);
  slow.cancel();
  board.dispose();
});

// ---------------------------------------------------------------------------
// board-wifi.js
// ---------------------------------------------------------------------------

test("NativeBoardWifiService constructor rejects a non-positive or non-integer timeout and hydrates cached state", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  assert.throws(() => new NativeBoardWifiService(adapter, { commandTimeoutMs: 0 }), /positive integer/);
  assert.throws(() => new NativeBoardWifiService(adapter, { commandTimeoutMs: 1.5 }), /positive integer/, "not a safe integer fails the isSafeInteger check specifically");
  const cachedAdapter = new MemoryBoardAdapter({
    descriptors: createDefaultBoardDescriptors(),
    cached: new Map([["wifi.station", { version: 1, kind: "state", instanceId: "wifi.station", handle: 0, reloadEpoch: 1, sequence: 1, observedAtMs: 0, payload: encodeBoardPayload({ status: "ok", value: { phase: "idle" } }) }]]),
  });
  const wifi = new NativeBoardWifiService(cachedAdapter);
  assert.equal(wifi.getState().status, "ready");
  wifi.dispose();
});

test("NativeBoardWifiService.diagnostics omits lastIssue on a fresh instance that has never failed a command", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  assert.equal("lastIssue" in wifi.diagnostics(), false);
  wifi.dispose();
});

test("NativeBoardWifiService hydrates a successfully connected cached state with valid station telemetry", () => {
  const station = { rssiDbm: -50, channel: 6, authKind: "wpa2" };
  const cachedAdapter = new MemoryBoardAdapter({
    descriptors: createDefaultBoardDescriptors(),
    cached: new Map([["wifi.station", { version: 1, kind: "state", instanceId: "wifi.station", handle: 0, reloadEpoch: 1, sequence: 1, observedAtMs: 0, payload: encodeBoardPayload({ status: "ok", value: { phase: "connected", station } }) }]]),
  });
  const wifi = new NativeBoardWifiService(cachedAdapter);
  assert.deepEqual(wifi.getState().value, { phase: "connected", station });
  wifi.dispose();
});

test("NativeBoardWifiService notifies an active subscriber's listener when a new state event is accepted", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  const seen = [];
  wifi.subscribe((state) => seen.push(state.status), context); // replays the initial "disabled" state synchronously
  assert.equal(seen.length, 1);
  wifi.accept({ version: 1, kind: "state", instanceId: "wifi.station", handle: 0, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", value: { phase: "idle" } }) });
  assert.equal(seen.length, 2, "setState()'s listener loop notified the still-subscribed listener of the new state");
  wifi.dispose();
});

test("NativeBoardWifiService.subscribe is a no-op once disposed or for an already-cancelled context, otherwise replays state", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  const seen = [];
  const unsubscribe = wifi.subscribe((state) => seen.push(state.status), context);
  assert.deepEqual(seen, ["ready"]);
  unsubscribe();
  assert.equal(wifi.subscribe(() => undefined, { reloadEpoch: 1, isCancelled: () => true })(), undefined);
  wifi.dispose();
  assert.equal(wifi.subscribe(() => seen.push("post-dispose"), context)(), undefined);
  assert.deepEqual(seen, ["ready"]);
});

test("NativeBoardWifiService.scan rejects an invalid request without submitting to the adapter", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  let terminal;
  const rejected = wifi.scan({ maxResults: -1 }, context);
  const unsubscribe = rejected.subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  assert.equal(terminal, "invalid-input");
  assert.equal(adapter.submitted.length, 0);
  assert.equal(unsubscribe(), undefined, "a rejected operation's subscribe() returns a no-op unsubscribe");
  assert.doesNotThrow(() => rejected.cancel(), "a rejected operation's cancel() is a no-op too");
  wifi.dispose();
});

test("NativeBoardWifiService.start rejects when disposed, when the context is cancelled, and at the pending-command budget", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  let terminal;
  wifi.connect({ reloadEpoch: 1, isCancelled: () => true }).subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  assert.equal(terminal, "cancelled");
  for (let index = 0; index < WIFI_MAX_PENDING_COMMANDS; index += 1) wifi.connect(context);
  wifi.connect(context).subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  assert.equal(terminal, "resource-exhausted");
  assert.equal(wifi.diagnostics().pendingCommands, WIFI_MAX_PENDING_COMMANDS);
  wifi.dispose();
  wifi.connect(context).subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  assert.equal(terminal, "cancelled", "start() also rejects once the service itself is disposed");
});

test("NativeBoardWifiService.start converts a queue-full submit error to resource-exhausted and any other error to hardware-failure", () => {
  class QueueFullAdapter extends MemoryBoardAdapter {
    submit() { throw new Error("board.submit: wifi-command-queue-full"); }
  }
  class BrokenAdapter extends MemoryBoardAdapter {
    submit() { throw new Error("boom"); }
  }
  let terminal;
  const queueFull = new NativeBoardWifiService(new QueueFullAdapter({ descriptors: createDefaultBoardDescriptors() }));
  queueFull.connect(context).subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  assert.equal(terminal, "resource-exhausted");
  assert.deepEqual(queueFull.diagnostics().lastIssue, { code: "resource-exhausted", retry: "never", diagnosticId: "wifi-command-queue-full" });
  queueFull.dispose();

  const broken = new NativeBoardWifiService(new BrokenAdapter({ descriptors: createDefaultBoardDescriptors() }));
  broken.connect(context).subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  assert.equal(terminal, "hardware-failure");
  broken.dispose();
});

test("NativeBoardWifiService.expire fails a lost command past its deadline and cancels one whose context was cancelled first", () => {
  let now = 0;
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter, { now: () => now, commandTimeoutMs: 10 });
  wifi.expire(); // no pending commands: the loop body never runs, which must be safe.

  let cancelled = false;
  const cancelledOp = wifi.connect({ reloadEpoch: 1, isCancelled: () => cancelled });
  let cancelledTerminal;
  cancelledOp.subscribe((state) => { cancelledTerminal = state.status === "failed" ? state.issue.code : state.status; });
  cancelled = true;
  wifi.expire();
  assert.equal(cancelledTerminal, "cancelled");

  const timedOp = wifi.connect(context);
  let timedTerminal;
  timedOp.subscribe((state) => { timedTerminal = state.status === "failed" ? state.issue.code : state.status; });
  now = 5;
  wifi.expire();
  assert.equal(timedTerminal, "running", "not yet at the deadline");
  now = 10;
  wifi.expire();
  assert.equal(timedTerminal, "timeout");
  wifi.dispose();
});

test("NativeBoardWifiService.accept ignores foreign instances and stale/duplicate sequences", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  assert.equal(wifi.accept({ version: 1, kind: "state", instanceId: "motion", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", value: { phase: "idle" } }) }), false, "a non-wifi instanceId is not this service's event");
  assert.equal(wifi.accept({ version: 1, kind: "state", instanceId: "wifi.station", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", value: { phase: "idle" } }) }), true);
  assert.equal(wifi.accept({ version: 1, kind: "state", instanceId: "wifi.station", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 0, payload: encodeBoardPayload({ status: "ok", value: { phase: "connecting" } }) }), true, "a non-newer event is swallowed (accepted, but ignored) rather than reprocessed");
  assert.equal(wifi.getState().value.phase, "idle");
  wifi.dispose();
});

test("NativeBoardWifiService.accept rejects a state event whose payload does not decode to a known Wi-Fi phase", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  assert.equal(wifi.accept({ version: 1, kind: "state", instanceId: "wifi.station", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", value: { phase: "connected", station: { rssiDbm: 1 } } }) }), false, "connected without valid station telemetry decodes to undefined");
  assert.equal(wifi.accept({ version: 1, kind: "state", instanceId: "wifi.station", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", value: { phase: "unknown-phase" } }) }), false);
  assert.equal(wifi.accept({ version: 1, kind: "state", instanceId: "wifi.station", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "not-ok" }) }), false, "status other than ok never decodes");
  wifi.dispose();
});

test("NativeBoardWifiService.accept cancels a stray operation event and reports on unmatched or cross-epoch handles", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  assert.equal(wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle: 999, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "succeeded", correlationId: "0" }) }), true, "an event for a handle with no record is swallowed");

  const stray = wifi.connect({ reloadEpoch: 2, isCancelled: () => false });
  const handle = adapter.submitted.at(-1).handle ?? adapter.submitted.length;
  let terminal;
  stray.subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  assert.equal(wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle: adapter.submitted.length, reloadEpoch: 999, sequence: 2, observedAtMs: 2, payload: encodeBoardPayload({ status: "succeeded", correlationId: String(stray.id) }) }), true, "a mismatched reloadEpoch cancels the stray operation instead of finishing it");
  assert.equal(terminal, "cancelled");
  wifi.dispose();
});

test("NativeBoardWifiService.accept cancels an operation whose context was cancelled after submission (matching handle and reloadEpoch)", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  let cancelled = false;
  const op = wifi.connect({ reloadEpoch: 1, isCancelled: () => cancelled });
  const handle = adapter.submitted.length;
  let terminal;
  op.subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  cancelled = true;
  assert.equal(wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "succeeded", correlationId: String(op.id) }) }), true, "record found and reloadEpoch matches, but the context itself is now cancelled");
  assert.equal(terminal, "cancelled");
  wifi.dispose();
});

test("NativeBoardWifiService.accept rejects an operation event whose payload does not decode at all", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  const operation = wifi.connect(context);
  const handle = adapter.submitted.length;
  assert.equal(wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: Uint8Array.from([0xff]) }), false, "a byte > 0x7f fails decodeBoardPayload entirely, before any correlationId check");
  wifi.dispose();
});

test("NativeBoardWifiService.cancel on an already-completed operation is a no-op", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  const op = wifi.connect(context);
  const handle = adapter.submitted.length;
  wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "succeeded", correlationId: String(op.id) }) });
  // The operation already finished and was removed from the service's bookkeeping;
  // cancelling it again must find no matching handle and no-op rather than throw.
  assert.doesNotThrow(() => op.cancel());
  wifi.dispose();
});

test("NativeOperation.finish is a no-op once the operation is no longer running", () => {
  // `finish` is a genuinely public method on the operation object returned by connect()
  // (just not part of the narrower WifiOperation type), so calling it twice directly is
  // exercising real, reachable behaviour, not bypassing any privacy boundary.
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  const op = wifi.connect(context);
  const handle = adapter.submitted.length;
  wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "succeeded", correlationId: String(op.id) }) });
  let seen;
  op.subscribe((state) => { seen = state; });
  assert.equal(seen.status, "succeeded");
  assert.doesNotThrow(() => op.finish({ status: "failed", id: op.id, issue: { code: "internal", retry: "never", diagnosticId: "x" } }));
  op.subscribe((state) => { seen = state; });
  assert.equal(seen.status, "succeeded", "the second finish() call was swallowed; state did not change");
  wifi.dispose();
});

test("NativeBoardWifiService.reject defends against an unused 'timeout' code (never produced by scan/start, only by expire's own direct issue() call)", () => {
  // Every real call site passes "invalid-input", "cancelled", "resource-exhausted", or
  // "hardware-failure" to reject(); expire() builds its own "timeout" issue inline via
  // issue(), never through reject(). The `code === "timeout"` ternary arm in reject() is
  // therefore dead from any public entry point — reject() is called directly here (a
  // plain, unmangled method; TS `private` is compile-time only) purely to document and
  // cover that defensive arm.
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  const operation = wifi.reject("timeout", "manual-retry-code-path");
  let terminal;
  operation.subscribe((state) => { terminal = state; });
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.issue.retry, "manual");
  wifi.dispose();
});

test("NativeBoardWifiService.expire and .finish defend against their internal operations/records maps ever falling out of lockstep", () => {
  // Every mutation the class performs keeps `records` and `operations` in lockstep (same
  // handle added/removed together in start()/finish()), so in practice a record is never
  // found without a matching operation, and vice versa. `operations` and `records` are
  // plain instance properties (not JS #-private), so this test pokes one map directly to
  // simulate the desync and cover the two defensive guards that assume it cannot happen.
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  let cancelled = false;
  const wifi = new NativeBoardWifiService(adapter);
  const op = wifi.connect({ reloadEpoch: 1, isCancelled: () => cancelled });
  const handle = adapter.submitted.length;
  wifi.operations.delete(handle);
  cancelled = true;
  assert.doesNotThrow(() => wifi.expire(), "expire()'s `operation !== undefined` guard covers the now-missing operations entry");

  const op2 = wifi.connect(context);
  const handle2 = adapter.submitted.length;
  wifi.operations.delete(handle2);
  assert.doesNotThrow(
    () => wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle: handle2, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "succeeded", correlationId: String(op2.id) }) }),
    "finish()'s `operation?.` optional chaining covers the now-missing operations entry",
  );
  wifi.dispose();
});

test("NativeBoardWifiService.accept requires a matching correlationId and a well-formed terminal payload", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  const operation = wifi.connect(context);
  const handle = adapter.submitted.length;
  assert.equal(wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "succeeded", correlationId: "not-the-id" }) }), false, "correlationId mismatch is redacted, not applied");
  assert.equal(wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "pending", correlationId: String(operation.id) }) }), false, "a non-terminal status is not a valid terminal payload");
  assert.equal(wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "failed", correlationId: String(operation.id), issue: { code: "not-a-real-code", retry: "never", diagnosticId: "x" } }) }), false, "an invalid issue shape fails validIssue and is redacted");
  assert.equal(wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "failed", correlationId: String(operation.id) }) }), false, "a failed status with no issue field at all is not even an object, so validIssue's typeof guard rejects it first");
  let terminal;
  operation.subscribe((state) => { terminal = state.status; });
  assert.equal(terminal, "running");
  assert.equal(wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle, reloadEpoch: 1, sequence: 2, observedAtMs: 2, payload: encodeBoardPayload({ status: "failed", correlationId: String(operation.id), issue: { code: "hardware-failure", retry: "never", diagnosticId: "radio-off" } }) }), true);
  operation.subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  assert.equal(terminal, "hardware-failure");
  assert.deepEqual(wifi.diagnostics().lastIssue, { code: "hardware-failure", retry: "never", diagnosticId: "radio-off" });
  wifi.dispose();
});

test("NativeBoardWifiService.accept resolves a succeeded scan to an empty frozen network list and a succeeded connect/disconnect to no value", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  const scan = wifi.scan({}, context);
  const scanHandle = adapter.submitted.length;
  wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle: scanHandle, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "succeeded", correlationId: String(scan.id) }) });
  let scanResult;
  const unsubscribeScan = scan.subscribe((state) => { if (state.status === "succeeded") scanResult = state.value; });
  assert.deepEqual(scanResult, []);
  assert.equal(Object.isFrozen(scanResult), true);
  assert.equal(unsubscribeScan(), undefined, "subscribing to an already-terminal operation returns the no-op unsubscribe");

  const disconnect = wifi.disconnect(context);
  const disconnectHandle = adapter.submitted.length;
  wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle: disconnectHandle, reloadEpoch: 1, sequence: 2, observedAtMs: 2, payload: encodeBoardPayload({ status: "succeeded", correlationId: String(disconnect.id) }) });
  let disconnectStatus;
  disconnect.subscribe((state) => { disconnectStatus = state.status; });
  assert.equal(disconnectStatus, "succeeded");
  wifi.dispose();
});

test("NativeBoardWifiService's operation subscribe/unsubscribe removes a listener while the command is still running", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  const operation = wifi.connect(context);
  const handle = adapter.submitted.length;
  let calls = 0;
  const unsubscribe = operation.subscribe(() => { calls += 1; });
  assert.equal(calls, 1, "subscribing replays the current running state immediately");
  unsubscribe();
  wifi.accept({ version: 1, kind: "operation", instanceId: "wifi.station", handle, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "succeeded", correlationId: String(operation.id) }) });
  assert.equal(calls, 1, "the listener was removed before completion, so it was never notified of the terminal state");
  wifi.dispose();
});

test("NativeBoardWifiService.dispose cancels every in-flight operation and is idempotent", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter);
  const pending = wifi.connect(context);
  let terminal;
  pending.subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  wifi.dispose();
  assert.equal(terminal, "cancelled");
  assert.doesNotThrow(() => wifi.dispose());
});
