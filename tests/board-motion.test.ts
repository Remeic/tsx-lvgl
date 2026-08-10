import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createCapabilityCatalog, createCapabilityToken, selectCapabilityInstance } from "@tsx-lvgl/capabilities";
import { BoardRuntime, MemoryBoardAdapter, createDefaultBoardDescriptors, encodeBoardPayload } from "@tsx-lvgl/device";
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
  assert.deepEqual(adapter.submitted, [{ version: 1, kind: "observe", instanceId: "motion", periodMs: 80 }]);
  adapter.emit({ version: 1, kind: "state", handle: 1, sequence: 1, observedAtMs: 10, payload: encodeBoardPayload({ status: "ok", value: frame, droppedSincePrevious: 0 }) });
  assert.deepEqual(states, ["starting", "starting", "ready", "ready"]);
  assert.equal(board.getBinding(motionSchema).state.status, "ready");
  first.cancel(); assert.equal(adapter.activeHandleCount(), 1);
  second.cancel(); second.cancel(); assert.deepEqual(adapter.cancelled, [1]);
  board.dispose();
});

test("malformed envelopes are redacted into bounded diagnostics", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: [motion] }); const board = new BoardRuntime(adapter);
  board.subscribe(motionSchema, {}, { reloadEpoch: 1, isCancelled: () => false }, () => undefined);
  adapter.emit({ version: 1, kind: "state", handle: 1, sequence: 1, observedAtMs: 1, payload: new Uint8Array([0xff]) });
  assert.deepEqual(board.diagnostics().lastIssue, { code: "protocol-error", retry: "never", diagnosticId: "board-reading" });
  assert.equal(board.diagnostics().droppedEvents, 1);
  board.dispose();
});
