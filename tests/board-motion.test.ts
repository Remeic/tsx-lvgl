import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createCapabilityCatalog, createCapabilityToken, selectCapabilityInstance } from "@tsx-lvgl/capabilities";
import { BoardRuntime, MemoryBoardAdapter, createBoardSchemaRegistry, createDefaultBoardDescriptors, encodeBoardPayload } from "@tsx-lvgl/device";
import { motionSchema } from "@tsx-lvgl/sensors";

const motion = createDefaultBoardDescriptors()[0]!;
const frame = { accelerationMps2: [0, 0, 9.80665], angularVelocityDps: [0, 0, 0] };

test("catalog is boot-frozen and selection never guesses an ambiguous instance", () => {
  const token = createCapabilityToken({ familyCode: 7, semanticId: "test.number", version: 1, delivery: "snapshot", validate: (value: unknown): value is number => typeof value === "number" });
  const catalog = createCapabilityCatalog([{ token, instance: { id: "primary", isDefault: true, source: "fixture" } }]);
  assert.equal(Object.isFrozen(catalog.list()[0]!), true);
  assert.equal(catalog.get(token)?.instance.id, "primary");
  assert.equal(selectCapabilityInstance([{ id: "one", isDefault: false, source: "a" }, { id: "two", isDefault: false, source: "b" }]).status, "ambiguous");
});

test("one board producer multiplexes subscribers, caches a validated motion reading, and cancels once", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  const states: string[] = [];
  const context = { reloadEpoch: 4, isCancelled: () => false };
  const first = board.subscribe(motionSchema, { periodMs: 80 }, context, (binding) => states.push(binding.state.status));
  const second = board.subscribe(motionSchema, { periodMs: 80 }, context, (binding) => states.push(binding.state.status));
  assert.deepEqual(adapter.submitted, [{ version: 1, kind: "observe", instanceId: "motion", periodMs: 80, reloadEpoch: 4 }]);
  board.commitEpoch(4);
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 4, sequence: 1, observedAtMs: 10, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame, droppedSincePrevious: 0 }) });
  assert.deepEqual(states, ["starting", "starting", "ready", "ready"]);
  assert.equal(board.getBinding(motionSchema).state.status, "ready");
  first.cancel(); assert.equal(adapter.activeHandleCount(), 1);
  second.cancel(); second.cancel(); assert.deepEqual(adapter.cancelled, [1]);
  board.dispose();
});

test("malformed envelopes are redacted into bounded diagnostics", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] }); const board = new BoardRuntime(adapter);
  board.subscribe(motionSchema, {}, { reloadEpoch: 1, isCancelled: () => false }, () => undefined);
  board.commitEpoch(1);
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: new Uint8Array([0xff]) });
  assert.deepEqual(board.diagnostics().lastIssue, { code: "protocol-error", retry: "never", diagnosticId: "board-reading" });
  assert.equal(board.diagnostics().droppedEvents, 1);
  board.dispose();
});

test("board runtime rejects schema-version and sequence regressions at the native envelope", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter);
  const received: number[] = [];
  board.subscribe(motionSchema, {}, { reloadEpoch: 1, isCancelled: () => false }, () => undefined, (event) => {
    if (event?.status === "ok") received.push(event.sequence);
  });
  board.commitEpoch(1);
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 2, observedAtMs: 2, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame }) });
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 2, observedAtMs: 3, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame }) });
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 3, observedAtMs: 4, payload: encodeBoardPayload({ status: "ok", schemaVersion: 2, value: frame }) });
  assert.deepEqual(received, [2]);
  assert.equal(board.diagnostics().droppedEvents, 2);
  board.dispose();
});

test("board runtime freezes injected schemas and fences stale native epochs", () => {
  const registry = createBoardSchemaRegistry([motionSchema]);
  assert.equal(Object.isFrozen(registry.list()), true);
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter, { registry });
  const received: number[] = [];
  board.subscribe(motionSchema, {}, { reloadEpoch: 1, isCancelled: () => false }, () => undefined, (event) => received.push(event.sequence));
  board.commitEpoch(1);
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 2, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame }) });
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 2, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame }) });
  board.subscribe(motionSchema, {}, { reloadEpoch: 2, isCancelled: () => false }, () => undefined, (event) => received.push(event.sequence));
  board.commitEpoch(2);
  assert.equal(adapter.cancelled.includes(1), true);
  adapter.emit({ version: 1, kind: "state", handle: 2, reloadEpoch: 1, sequence: 1, observedAtMs: 3, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame }) });
  adapter.emit({ version: 1, kind: "state", handle: 2, reloadEpoch: 2, sequence: 1, observedAtMs: 4, payload: encodeBoardPayload({ status: "ok", schemaVersion: 1, value: frame }) });
  assert.deepEqual(received, [1, 1]);
  assert.equal(board.diagnostics().droppedEvents, 2);
  board.dispose();
});

test("board runtime bounds subscriber delivery and rejects unsafe issue text", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] });
  const board = new BoardRuntime(adapter, { limits: { maxSubscribers: 1, maxQueuedDeliveries: 1 } });
  const context = { reloadEpoch: 1, isCancelled: () => false };
  board.subscribe(motionSchema, {}, context, () => undefined);
  let limited = "";
  board.subscribe(motionSchema, {}, context, (binding) => { if (binding.state.status === "unavailable") limited = binding.state.issue.diagnosticId; });
  assert.equal(limited, "board-subscriber-budget");
  board.commitEpoch(1);
  adapter.emit({ version: 1, kind: "state", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1, payload: encodeBoardPayload({ status: "error", schemaVersion: 1, issue: { code: "internal", retry: "never", diagnosticId: "BAD\u0000ID" } }) });
  assert.equal(board.diagnostics().lastIssue?.diagnosticId, "board-reading");
  assert.equal(board.diagnostics().resourceUse.subscriberBudget, 1);
  board.dispose();
});
