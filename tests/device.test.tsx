import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ElementType } from "@tsx-lvgl/core";
import {
  NATIVE_STYLE_PROP,
  createClickRegistry,
  createDeviceScheduler,
  createKernel,
  createLvglHost,
  createNativeMotionSensor,
  type DeviceKernel,
} from "@tsx-lvgl/device";
import type { RuntimeBundle, RuntimeBundleManifest } from "@tsx-lvgl/runtime";
import { motionSchema, type SensorContext } from "@tsx-lvgl/sensors";
import { FakeNativeLvgl, FakeNativeSensors, FakeNativeTimers, makeFakeNative } from "./support/fake-native.js";

function instanceId(instance: unknown): number {
  return (instance as { id: number }).id;
}

// ---------------------------------------------------------------------------
// lvgl-host
// ---------------------------------------------------------------------------

test("createLvglHost maps every ElementType to its native widget kind", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const cases: ReadonlyArray<readonly [ElementType, Record<string, unknown>, string]> = [
    ["Screen", {}, "screen"],
    ["View", {}, "view"],
    ["Text", { text: "x" }, "text"],
    ["Button", { label: "x" }, "button"],
  ];
  for (const [type, props, kind] of cases) {
    const instance = host.createInstance(type, props);
    assert.equal(lvgl.kindOf(instanceId(instance)), kind);
  }
});

test("createInstance never calls setText for Screen or View", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const before = lvgl.setTextCalls.length;
  host.createInstance("Screen", {});
  host.createInstance("View", {});
  assert.equal(lvgl.setTextCalls.length, before, "Screen/View must never receive a setText call");
});

test("Text sets its initial text and coerces a numeric value to a string", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const stringInstance = host.createInstance("Text", { text: "hello" });
  assert.equal(lvgl.textOf(instanceId(stringInstance)), "hello");
  const numberInstance = host.createInstance("Text", { text: 42 });
  assert.equal(lvgl.textOf(instanceId(numberInstance)), "42");
});

test("updateInstance issues setText only when the coerced Text value actually changes", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const instance = host.createInstance("Text", { text: "same" });
  const before = lvgl.setTextCalls.length;
  host.updateInstance(instance, "Text", { text: "same" }, { text: "same" });
  assert.equal(lvgl.setTextCalls.length, before, "an unchanged text must not call setText");
  host.updateInstance(instance, "Text", { text: "same" }, { text: 7 });
  assert.equal(lvgl.setTextCalls.length, before + 1, "a changed text must call setText exactly once");
  assert.equal(lvgl.textOf(instanceId(instance)), "7");
});

test("updateInstance is a no-op for View and Screen instances", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const view = host.createInstance("View", {});
  const beforeText = lvgl.setTextCalls.length;
  const beforeClickable = lvgl.setClickableCalls.length;
  host.updateInstance(view, "View", {}, {});
  assert.equal(lvgl.setTextCalls.length, beforeText);
  assert.equal(lvgl.setClickableCalls.length, beforeClickable);
});

test("updateInstance never treats a non-Button type as a Button, even with label/onClick-shaped props", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const view = host.createInstance("View", {});
  const beforeText = lvgl.setTextCalls.length;
  host.updateInstance(view, "View", { label: "a" }, { label: "b", onClick: () => undefined });
  assert.equal(lvgl.setTextCalls.length, beforeText, "View must never receive a Button-style setText call");
  assert.equal(lvgl.setClickableCalls.length, 0, "View must never become clickable");
});

test("updateInstance issues setText for a Button only when its label actually changes", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const instance = host.createInstance("Button", { label: "go" });
  const before = lvgl.setTextCalls.length;
  host.updateInstance(instance, "Button", { label: "go" }, { label: "go" });
  assert.equal(lvgl.setTextCalls.length, before, "an unchanged Button label must not call setText");
});

test("Button onClick replacement swaps the handler and never fires the stale closure", () => {
  const lvgl = new FakeNativeLvgl();
  const clicks = createClickRegistry();
  const host = createLvglHost(lvgl, clicks);
  let firstCalls = 0;
  let secondCalls = 0;
  const instance = host.createInstance("Button", { label: "go", onClick: () => { firstCalls += 1; } });
  const id = instanceId(instance);
  assert.equal(lvgl.isClickable(id), true);
  clicks.dispatch(id);
  assert.equal(firstCalls, 1);

  const clickableCallsAfterMount = lvgl.setClickableCalls.length;
  host.updateInstance(
    instance,
    "Button",
    { label: "go", onClick: () => undefined },
    { label: "go", onClick: () => { secondCalls += 1; } },
  );
  assert.equal(lvgl.setClickableCalls.length, clickableCallsAfterMount, "replacing a live handler must not re-toggle clickability");
  clicks.dispatch(id);
  assert.equal(firstCalls, 1, "the old handler must not fire after replacement");
  assert.equal(secondCalls, 1);
});

test("Button onClick removal clears the registry entry and turns off clickability", () => {
  const lvgl = new FakeNativeLvgl();
  const clicks = createClickRegistry();
  const host = createLvglHost(lvgl, clicks);
  let calls = 0;
  const instance = host.createInstance("Button", { label: "go", onClick: () => { calls += 1; } });
  const id = instanceId(instance);

  host.updateInstance(instance, "Button", { label: "go", onClick: () => undefined }, { label: "go" });
  assert.equal(lvgl.isClickable(id), false);
  clicks.dispatch(id);
  assert.equal(calls, 0, "dispatch after removal must be a no-op");
});

test("Button onClick addition after mount turns clickability on", () => {
  const lvgl = new FakeNativeLvgl();
  const clicks = createClickRegistry();
  const host = createLvglHost(lvgl, clicks);
  const instance = host.createInstance("Button", { label: "go" });
  const id = instanceId(instance);
  assert.equal(lvgl.isClickable(id), false);

  let calls = 0;
  host.updateInstance(instance, "Button", { label: "go" }, { label: "go", onClick: () => { calls += 1; } });
  assert.equal(lvgl.isClickable(id), true);
  clicks.dispatch(id);
  assert.equal(calls, 1);
});

test("updateInstance leaves click state untouched when neither side defines onClick", () => {
  const lvgl = new FakeNativeLvgl();
  const clicks = createClickRegistry();
  const host = createLvglHost(lvgl, clicks);
  const instance = host.createInstance("Button", { label: "go" });
  const before = lvgl.setClickableCalls.length;
  host.updateInstance(instance, "Button", { label: "go" }, { label: "still" });
  assert.equal(lvgl.setClickableCalls.length, before);
  assert.equal(lvgl.textOf(instanceId(instance)), "still");
});

test("dispose clears the click registry entry and calls native dispose", () => {
  const lvgl = new FakeNativeLvgl();
  const clicks = createClickRegistry();
  const host = createLvglHost(lvgl, clicks);
  let calls = 0;
  const instance = host.createInstance("Button", { label: "go", onClick: () => { calls += 1; } });
  const id = instanceId(instance);

  host.dispose(instance);
  assert.equal(lvgl.isAlive(id), false);
  clicks.dispatch(id);
  assert.equal(calls, 0, "dispatch after dispose must be a no-op");
});

test("insertChild passes parent, child, and index straight through to native.insert", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const parent = host.createInstance("Screen", {});
  const childA = host.createInstance("Text", { text: "a" });
  const childB = host.createInstance("Text", { text: "b" });
  host.insertChild(parent, childA, 0);
  host.insertChild(parent, childB, 1);
  assert.deepEqual(lvgl.childrenOf(instanceId(parent)), [instanceId(childA), instanceId(childB)]);
});

test("insertChild and removeChild with a null parent are no-ops on the native binding", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const child = host.createInstance("Text", { text: "root" });
  const insertsBefore = lvgl.insertCalls.length;
  const removesBefore = lvgl.removeCalls.length;
  host.insertChild(null, child, 0);
  host.removeChild(null, child);
  assert.equal(lvgl.insertCalls.length, insertsBefore);
  assert.equal(lvgl.removeCalls.length, removesBefore);
});

test("removeChild with a real parent delegates to native.remove", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const parent = host.createInstance("Screen", {});
  const child = host.createInstance("Text", { text: "a" });
  host.insertChild(parent, child, 0);
  host.removeChild(parent, child);
  assert.deepEqual(lvgl.childrenOf(instanceId(parent)), []);
});

test("replaceRoot loads the next screen, or a blank screen (0) when next is null", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const screen = host.createInstance("Screen", {});
  host.replaceRoot(screen, null);
  assert.equal(lvgl.loadedScreen, instanceId(screen));
  host.replaceRoot(null, screen);
  assert.equal(lvgl.loadedScreen, 0);
});

// ---------------------------------------------------------------------------
// style
// ---------------------------------------------------------------------------

test("createInstance applies a style for every widget type, including Screen and View", () => {
  const cases: ReadonlyArray<readonly [ElementType, Record<string, unknown>]> = [
    ["Screen", { style: { backgroundColor: "red" } }],
    ["View", { style: { backgroundColor: "red" } }],
    ["Text", { text: "x", style: { backgroundColor: "red" } }],
    ["Button", { label: "x", style: { backgroundColor: "red" } }],
  ];
  for (const [type, props] of cases) {
    const lvgl = new FakeNativeLvgl();
    const host = createLvglHost(lvgl, createClickRegistry());
    const instance = host.createInstance(type, props);
    assert.equal(lvgl.styleOf(instanceId(instance), NATIVE_STYLE_PROP.backgroundColor), 0xff0000, type);
  }
});

test("createInstance with no style makes no style calls", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  host.createInstance("View", {});
  assert.deepEqual(lvgl.setStyleCalls, []);
  assert.deepEqual(lvgl.resetStyleCalls, []);
});

test("updateInstance emits setStyle only for the style key that actually changed", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const instance = host.createInstance("View", { style: { backgroundColor: "red", borderWidth: 1 } });
  const before = lvgl.setStyleCalls.length;
  host.updateInstance(
    instance,
    "View",
    { style: { backgroundColor: "red", borderWidth: 1 } },
    { style: { backgroundColor: "red", borderWidth: 2 } },
  );
  const emitted = lvgl.setStyleCalls.slice(before);
  assert.deepEqual(emitted, [{ id: instanceId(instance), prop: NATIVE_STYLE_PROP.borderWidth, value: 2 }]);
});

test("updateInstance emits resetStyle when a style key is removed on the next render", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const instance = host.createInstance("View", { style: { borderWidth: 1 } });
  host.updateInstance(instance, "View", { style: { borderWidth: 1 } }, { style: {} });
  assert.deepEqual(lvgl.resetStyleCalls, [{ id: instanceId(instance), prop: NATIVE_STYLE_PROP.borderWidth }]);
});

test("updateInstance with a re-normalized identical style makes zero native calls", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const instance = host.createInstance("View", { style: { backgroundColor: "red", padding: 4 } });
  const setBefore = lvgl.setStyleCalls.length;
  const resetBefore = lvgl.resetStyleCalls.length;
  // A fresh object literal with the same content: the reconciler's shallow
  // sameProps identity check re-triggers updateInstance every render, but the
  // per-key diff must still emit nothing.
  host.updateInstance(
    instance,
    "View",
    { style: { backgroundColor: "red", padding: 4 } },
    { style: { backgroundColor: "red", padding: 4 } },
  );
  assert.equal(lvgl.setStyleCalls.length, setBefore);
  assert.equal(lvgl.resetStyleCalls.length, resetBefore);
});

test("createInstance and updateInstance apply S2 width/left/display through the host contract", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const instance = host.createInstance("View", { style: { width: 120, left: -4, display: "none" } });
  assert.equal(lvgl.styleOf(instanceId(instance), NATIVE_STYLE_PROP.width), 120);
  assert.equal(lvgl.styleOf(instanceId(instance), NATIVE_STYLE_PROP.left), -4);
  assert.equal(lvgl.styleOf(instanceId(instance), NATIVE_STYLE_PROP.display), 1);

  const before = lvgl.setStyleCalls.length;
  host.updateInstance(
    instance,
    "View",
    { style: { width: 120, left: -4, display: "none" } },
    { style: { width: "50%", left: -4, display: "flex" } },
  );
  const emitted = lvgl.setStyleCalls.slice(before);
  assert.deepEqual(emitted, [
    { id: instanceId(instance), prop: NATIVE_STYLE_PROP.width, value: -51 },
    { id: instanceId(instance), prop: NATIVE_STYLE_PROP.display, value: 0 },
  ]);
});

test("createInstance and updateInstance apply S3 flexDirection/gap through the host contract", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const instance = host.createInstance("View", { style: { flexDirection: "row", gap: 4 } });
  assert.equal(lvgl.styleOf(instanceId(instance), NATIVE_STYLE_PROP.flexDirection), 0);
  assert.equal(lvgl.styleOf(instanceId(instance), NATIVE_STYLE_PROP.gap), 4);

  const before = lvgl.setStyleCalls.length;
  host.updateInstance(
    instance,
    "View",
    { style: { flexDirection: "row", gap: 4 } },
    { style: { flexDirection: "column", gap: 4 } },
  );
  const emitted = lvgl.setStyleCalls.slice(before);
  assert.deepEqual(emitted, [{ id: instanceId(instance), prop: NATIVE_STYLE_PROP.flexDirection, value: 1 }]);
});

test("createInstance and updateInstance apply S4 opacity/rotate through the host contract, and removing rotate resets it", () => {
  const lvgl = new FakeNativeLvgl();
  const host = createLvglHost(lvgl, createClickRegistry());
  const instance = host.createInstance("View", { style: { opacity: 0.5, rotate: 45 } });
  assert.equal(lvgl.styleOf(instanceId(instance), NATIVE_STYLE_PROP.opacity), 128);
  assert.equal(lvgl.styleOf(instanceId(instance), NATIVE_STYLE_PROP.rotate), 450);

  host.updateInstance(instance, "View", { style: { opacity: 0.5, rotate: 45 } }, { style: { opacity: 0.5 } });
  assert.deepEqual(
    lvgl.resetStyleCalls.filter((call) => call.id === instanceId(instance)),
    [{ id: instanceId(instance), prop: NATIVE_STYLE_PROP.rotate }],
  );
});

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

test("createDeviceScheduler drains enqueued tasks in FIFO order", () => {
  const timers = new FakeNativeTimers();
  const scheduler = createDeviceScheduler(timers);
  const order: number[] = [];
  scheduler.enqueue(() => order.push(1));
  scheduler.enqueue(() => order.push(2));
  scheduler.drain();
  assert.deepEqual(order, [1, 2]);
});

test("a task enqueued while draining is deferred to the next drain call", () => {
  const timers = new FakeNativeTimers();
  const scheduler = createDeviceScheduler(timers);
  const order: number[] = [];
  scheduler.enqueue(() => {
    order.push(1);
    scheduler.enqueue(() => order.push(2));
  });
  scheduler.drain();
  assert.deepEqual(order, [1]);
  scheduler.drain();
  assert.deepEqual(order, [1, 2]);
});

test("setInterval and clearInterval delegate to the native timer binding", () => {
  const timers = new FakeNativeTimers();
  const scheduler = createDeviceScheduler(timers);
  let calls = 0;
  const handle = scheduler.setInterval(() => { calls += 1; }, 50);
  timers.advance(50);
  assert.equal(calls, 1);
  scheduler.clearInterval(handle);
  timers.advance(50);
  assert.equal(calls, 1, "a cleared interval must not fire again");
  assert.equal(timers.activeCount, 0);
});

// ---------------------------------------------------------------------------
// sensors
// ---------------------------------------------------------------------------

const sensorContext: SensorContext = { reloadEpoch: 5, isCancelled: () => false };
const stillMotion = { accelerationMps2: [0, 0, 9.80665] as const, angularVelocityDps: [0, 0, 0] as const };

test("read restamps reloadEpoch and assigns a monotonically increasing sequence", async () => {
  const sensors = new FakeNativeSensors();
  const timers = new FakeNativeTimers();
  sensors.script(motionSchema.id, { status: "ok", sampledAtMs: 10, value: stillMotion });
  const sensor = createNativeMotionSensor(sensors, timers);

  assert.equal(sensor.schema, motionSchema);
  const first = await sensor.read(sensorContext);
  assert.equal(first.reloadEpoch, 5);
  assert.equal(first.sequence, 1);
  assert.equal(first.status, "ok");
  assert.deepEqual(first.value, stillMotion);

  const second = await sensor.read(sensorContext);
  assert.equal(second.sequence, 2);
});

test("an unavailable native reading is forwarded without a value", async () => {
  const sensors = new FakeNativeSensors();
  const timers = new FakeNativeTimers();
  sensors.script(motionSchema.id, { status: "unavailable", sampledAtMs: 3 });
  const sensor = createNativeMotionSensor(sensors, timers);

  const sample = await sensor.read(sensorContext);
  assert.equal(sample.status, "unavailable");
  assert.equal(sample.value, undefined);
});

test("a value that fails schema validation is dropped even when status is ok", async () => {
  const sensors = new FakeNativeSensors();
  const timers = new FakeNativeTimers();
  sensors.script(motionSchema.id, { status: "ok", sampledAtMs: 1, value: { bogus: true } });
  const sensor = createNativeMotionSensor(sensors, timers);

  const sample = await sensor.read(sensorContext);
  assert.equal(sample.status, "ok");
  assert.equal(sample.value, undefined);
});

test("subscribe polls the native timer at the configured period and shares the sequence counter with read", async () => {
  const sensors = new FakeNativeSensors();
  const timers = new FakeNativeTimers();
  sensors.script(motionSchema.id, { status: "ok", sampledAtMs: 1, value: stillMotion });
  const sensor = createNativeMotionSensor(sensors, timers, 80);

  const received: number[] = [];
  const cancel = sensor.subscribe((next) => received.push(next.sequence), sensorContext);
  assert.equal(timers.activeCount, 1);
  await sensor.read(sensorContext);
  timers.advance(80);
  timers.advance(80);
  assert.deepEqual(received, [2, 3]);

  cancel();
  timers.advance(80);
  assert.deepEqual(received, [2, 3], "unsubscribe must stop the native timer");
  assert.equal(timers.activeCount, 0);
});

test("createNativeMotionSensor defaults the poll period to 80ms", () => {
  const sensors = new FakeNativeSensors();
  const timers = new FakeNativeTimers();
  sensors.script(motionSchema.id, { status: "ok", sampledAtMs: 1, value: stillMotion });
  const sensor = createNativeMotionSensor(sensors, timers);

  const received: number[] = [];
  sensor.subscribe((next) => received.push(next.sequence), sensorContext);
  timers.advance(79);
  assert.equal(received.length, 0);
  timers.advance(1);
  assert.equal(received.length, 1);
});

// ---------------------------------------------------------------------------
// kernel
// ---------------------------------------------------------------------------

function manifest(overrides: { generation: number; byteLength: number } & Partial<RuntimeBundleManifest>): RuntimeBundleManifest {
  return {
    bundleId: "app",
    format: "js",
    engine: "quickjs-ng",
    protocolVersion: 1,
    boardId: "esp32s3-waveshare-v1",
    sha256: "a".repeat(64),
    ...overrides,
  };
}

function encode(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

const sourceA = `
  const lib = require("@tsx-lvgl/core");
  const rt = require("@tsx-lvgl/runtime");
  exports.default = function App() {
    const [count, setCount] = rt.useState(0);
    rt.useInterval(function () { setCount(function (c) { return c + 1; }); }, 100);
    return lib.createVNode(lib.Screen, null, [lib.createVNode(lib.Text, { text: "A:" + count })]);
  };
`;

const sourceB = `
  const lib = require("@tsx-lvgl/core");
  const rt = require("@tsx-lvgl/runtime");
  exports.default = function App() {
    const [count, setCount] = rt.useState(0);
    rt.useInterval(function () { setCount(function (c) { return c + 1; }); }, 100);
    return lib.createVNode(lib.Screen, null, [lib.createVNode(lib.Text, { text: "B:" + count })]);
  };
`;

const sdkAliasSource = `
  const sdk = require("@tsx-lvgl/sdk");
  const jsx = require("@tsx-lvgl/sdk/jsx-runtime");
  exports.default = function App() {
    const sample = sdk.useMotion();
    const surface = Object.keys(sdk).sort().join(",") === "Button,Fragment,Screen,StyleSheet,Text,View,isShake,useEffect,useInterval,useMotion,useState,useWifi"
      ? "sdk"
      : "sdk-leak";
    return jsx.jsx(sdk.Screen, { children: jsx.jsx(sdk.Text, { text: sample.state.status === "starting" ? surface : sample.state.status }) });
  };
`;

function startKernel(): { kernel: DeviceKernel; fake: ReturnType<typeof makeFakeNative> } {
  const fake = makeFakeNative();
  const kernel = createKernel(fake.native);
  const bundleA: RuntimeBundle = { manifest: manifest({ generation: 1, byteLength: sourceA.length }), source: encode(sourceA) };
  kernel.start(bundleA);
  return { kernel, fake };
}

test("kernel.start mounts the initial bundle and throws on an invalid one", () => {
  const fake = makeFakeNative();
  const kernel = createKernel(fake.native);
  assert.throws(
    () => kernel.start({ manifest: manifest({ generation: 1, byteLength: 1, boardId: "other-board" }), source: encode("x") }),
    /bundle rejected: board-mismatch/,
  );

  const bundleA: RuntimeBundle = { manifest: manifest({ generation: 1, byteLength: sourceA.length }), source: encode(sourceA) };
  kernel.start(bundleA);
  assert.deepEqual(fake.lvgl.liveTexts(), ["A:0"]);
  assert.equal(kernel.lastGeneration(), 1);
});

test("kernel resolves the stable SDK and JSX runtime aliases", () => {
  const fake = makeFakeNative();
  const kernel = createKernel(fake.native);
  fake.sensors.script(motionSchema.id, { status: "unavailable", sampledAtMs: 0 });
  kernel.start({ manifest: manifest({ generation: 1, byteLength: sdkAliasSource.length }), source: encode(sdkAliasSource) });
  assert.deepEqual(fake.lvgl.liveTexts(), ["sdk"]);
});

test("kernel.start propagates the exact 'unknown module' message uncaught for an unresolved require", () => {
  const fake = makeFakeNative();
  const kernel = createKernel(fake.native);
  const badSource = 'require("@tsx-lvgl/nope");';
  assert.throws(
    () => kernel.start({ manifest: manifest({ generation: 1, byteLength: badSource.length }), source: encode(badSource) }),
    (error: unknown) => error instanceof Error && error.message === "unknown module: @tsx-lvgl/nope",
  );
});

test("stageReload commits a valid, monotonically newer generation and disposes the previous root", () => {
  const { kernel, fake } = startKernel();
  const idsBefore = fake.lvgl.liveTexts();
  assert.deepEqual(idsBefore, ["A:0"]);

  const result = kernel.stageReload(JSON.stringify(manifest({ generation: 2, byteLength: sourceB.length })), sourceB);
  assert.equal(result, "committed 2");
  assert.deepEqual(fake.lvgl.liveTexts(), ["B:0"]);
  assert.equal(kernel.lastGeneration(), 2);
  assert.match(fake.logs.at(-1) ?? "", /kernel: reload committed epoch=2/);
});

test("stageReload rejects a stale (non-monotonic) generation and leaves the tree untouched", () => {
  const { kernel, fake } = startKernel();
  kernel.stageReload(JSON.stringify(manifest({ generation: 2, byteLength: sourceB.length })), sourceB);

  const result = kernel.stageReload(JSON.stringify(manifest({ generation: 2, byteLength: sourceB.length })), sourceB);
  assert.equal(result, "rejected generation-not-monotonic");
  assert.deepEqual(fake.lvgl.liveTexts(), ["B:0"]);
  assert.equal(kernel.lastGeneration(), 2);
});

test("stageReload rejects malformed manifest JSON before touching the runtime", () => {
  const { kernel, fake } = startKernel();
  const result = kernel.stageReload("{not json", sourceB);
  assert.equal(result, "rejected malformed-manifest");
  assert.deepEqual(fake.lvgl.liveTexts(), ["A:0"]);
  assert.equal(kernel.lastGeneration(), 1);
  assert.match(fake.logs.at(-1) ?? "", /kernel: reload rejected malformed-manifest \(JSON parse error\)/);
});

test("stageReload rejects a syntactically valid non-object manifest", () => {
  const { kernel, fake } = startKernel();
  const result = kernel.stageReload("null", sourceB);
  assert.equal(result, "rejected malformed-manifest");
  assert.deepEqual(fake.lvgl.liveTexts(), ["A:0"]);
  assert.equal(kernel.lastGeneration(), 1);
});

test("stageReload rejects non-ascii source before touching the runtime", () => {
  const { kernel, fake } = startKernel();
  const nonAsciiSource = "const x = 'héllo';";
  const result = kernel.stageReload(JSON.stringify(manifest({ generation: 2, byteLength: nonAsciiSource.length })), nonAsciiSource);
  assert.equal(result, "rejected non-ascii");
  assert.deepEqual(fake.lvgl.liveTexts(), ["A:0"]);
  assert.equal(kernel.lastGeneration(), 1);
  assert.match(fake.logs.at(-1) ?? "", /kernel: reload rejected non-ascii/);
});

test("stageReload rejects a source byte at exactly the 0x80 non-ascii boundary", () => {
  const { kernel, fake } = startKernel();
  const boundarySource = 'const x = "\x80";';
  const result = kernel.stageReload(JSON.stringify(manifest({ generation: 2, byteLength: boundarySource.length })), boundarySource);
  assert.equal(result, "rejected non-ascii");
  assert.deepEqual(fake.lvgl.liveTexts(), ["A:0"]);
  assert.equal(kernel.lastGeneration(), 1);
});

test("a throwing candidate rolls back, leaves the active root and its timers alive, and the same generation may be retried", () => {
  const { kernel, fake } = startKernel();
  kernel.stageReload(JSON.stringify(manifest({ generation: 2, byteLength: sourceB.length })), sourceB);
  assert.deepEqual(fake.lvgl.liveTexts(), ["B:0"]);

  const throwingSource = "exports.default = function () { throw new Error('boom'); };";
  const rolledBack = kernel.stageReload(
    JSON.stringify(manifest({ generation: 3, byteLength: throwingSource.length })),
    throwingSource,
  );
  assert.equal(rolledBack, "rolled_back");
  assert.equal(kernel.lastGeneration(), 2, "a rollback must not advance lastGeneration");
  assert.deepEqual(fake.lvgl.liveTexts(), ["B:0"], "the active root must survive the rollback");

  fake.timers.advance(100);
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["B:1"], "the active root's interval must still fire after the rollback");

  const retried = kernel.stageReload(
    JSON.stringify(manifest({ generation: 3, byteLength: sourceA.length })),
    sourceA,
  );
  assert.equal(retried, "committed 3");
  assert.deepEqual(fake.lvgl.liveTexts(), ["A:0"]);
  assert.equal(kernel.lastGeneration(), 3);
});

test("stageReload rolls back when the bundle requires an unknown module", () => {
  const { kernel, fake } = startKernel();
  const badSource = 'require("@tsx-lvgl/nope");';
  const result = kernel.stageReload(
    JSON.stringify(manifest({ generation: 2, byteLength: badSource.length })),
    badSource,
  );
  assert.equal(result, "rolled_back");
  assert.deepEqual(fake.lvgl.liveTexts(), ["A:0"], "the active root must survive the rollback");
  assert.equal(kernel.lastGeneration(), 1, "a rollback must not advance lastGeneration");
  assert.equal(fake.logs.at(-1), "kernel: reload rolled_back");
});

test("a post-commit re-render that throws reaches native.log through Runtime.onError", () => {
  const throwsOnSecondRender = `
    const lib = require("@tsx-lvgl/core");
    const rt = require("@tsx-lvgl/runtime");
    exports.default = function App() {
      const [count, setCount] = rt.useState(0);
      rt.useInterval(function () { setCount(function (c) { return c + 1; }); }, 100);
      if (count > 0) { throw new Error("render boom"); }
      return lib.createVNode(lib.Screen, null, [lib.createVNode(lib.Text, { text: "T:" + count })]);
    };
  `;
  const fake = makeFakeNative();
  const kernel = createKernel(fake.native);
  kernel.start({ manifest: manifest({ generation: 1, byteLength: throwsOnSecondRender.length }), source: encode(throwsOnSecondRender) });
  assert.deepEqual(fake.lvgl.liveTexts(), ["T:0"]);

  fake.timers.advance(100);
  kernel.pump();
  assert.equal(fake.logs.at(-1), "kernel: error Error: render boom");
  assert.deepEqual(fake.lvgl.liveTexts(), ["T:0"], "the failed re-render must leave the previous tree in place");
});

test("a Button's onClick reaches the bundle through native.onClick dispatch", () => {
  const sourceWithButton = `
    const lib = require("@tsx-lvgl/core");
    const rt = require("@tsx-lvgl/runtime");
    exports.default = function App() {
      const [clicked, setClicked] = rt.useState(false);
      return lib.createVNode(lib.Screen, null, [
        lib.createVNode(lib.Text, { text: clicked ? "clicked" : "idle" }),
        lib.createVNode(lib.Button, { label: "go", onClick: function () { setClicked(true); } }),
      ]);
    };
  `;
  const fake = makeFakeNative();
  const kernel = createKernel(fake.native);
  kernel.start({ manifest: manifest({ generation: 1, byteLength: sourceWithButton.length }), source: encode(sourceWithButton) });
  assert.deepEqual(fake.lvgl.liveTexts(), ["idle"]);

  const [buttonId] = fake.lvgl.liveIdsOfKind("button");
  assert.ok(buttonId);
  fake.dispatchClick(buttonId);
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["clicked"]);
});

test("useSensor re-renders after a subscribed motion sample is delivered and pumped", async () => {
  const sensorSource = `
    const lib = require("@tsx-lvgl/core");
    const rt = require("@tsx-lvgl/runtime");
    const sensors = require("@tsx-lvgl/sensors");
    exports.default = function App() {
      const sample = rt.useSensor(sensors.motionSchema);
      var shaking = sample && sample.status === "ok" && sensors.isShake(sample.value);
      return lib.createVNode(lib.Screen, null, [lib.createVNode(lib.Text, { text: shaking ? "shake" : "still" })]);
    };
  `;
  const fake = makeFakeNative();
  fake.sensors.script(motionSchema.id, { status: "ok", sampledAtMs: 0, value: stillMotion });
  const kernel = createKernel(fake.native);
  kernel.start({ manifest: manifest({ generation: 1, byteLength: sensorSource.length }), source: encode(sensorSource) });

  await Promise.resolve();
  await Promise.resolve();
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["still"]);

  const shakeMotion = { accelerationMps2: [30, 0, 0] as const, angularVelocityDps: [0, 0, 0] as const };
  fake.sensors.script(motionSchema.id, { status: "ok", sampledAtMs: 80, value: shakeMotion });
  fake.timers.advance(80);
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["shake"]);
});
