import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as core from "@tsx-lvgl/core";
import {
  createProgramEngine,
  decodeAsciiSource,
  type ModuleResolver,
  type RuntimeBundleManifest,
  type RuntimeBundlePolicy,
} from "@tsx-lvgl/runtime";
import { createHarness } from "./support/harness.js";

function encode(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function manifest(overrides: Partial<RuntimeBundleManifest> = {}): RuntimeBundleManifest {
  return {
    bundleId: "test-bundle",
    format: "js",
    engine: "quickjs-ng",
    protocolVersion: 1,
    boardId: "esp32s3-waveshare-v1",
    generation: 1,
    sha256: "a".repeat(64),
    byteLength: 0,
    ...overrides,
  };
}

const throwingResolver: ModuleResolver = (specifier: string) => {
  throw new Error(`unknown module: ${specifier}`);
};

test("decodeAsciiSource accepts every byte through 0x7F and rejects the first byte >= 0x80", () => {
  assert.equal(decodeAsciiSource(new Uint8Array([])), "");
  assert.equal(decodeAsciiSource(encode("hi")), "hi");
  assert.equal(decodeAsciiSource(new Uint8Array([0x7f])), "\x7f");
  assert.throws(() => decodeAsciiSource(new Uint8Array([0x80])), /non-ascii byte at 0/);
  assert.throws(() => decodeAsciiSource(new Uint8Array([0x41, 0x80])), /non-ascii byte at 1/);
});

test("createProgramEngine exposes the given engine name unchanged", () => {
  assert.equal(createProgramEngine("quickjs-ng", throwingResolver).name, "quickjs-ng");
  assert.equal(createProgramEngine("moddable-xs", throwingResolver).name, "moddable-xs");
});

test("evaluate resolves a function default export into a component VNode", () => {
  const engine = createProgramEngine("quickjs-ng", throwingResolver);
  const source = encode("exports.default = function App() { return null; };");
  const vnode = engine.evaluate(source, manifest());
  assert.equal(vnode.kind, "component");
  assert.equal(typeof vnode.type, "function");
  assert.deepEqual(vnode.props, {});
  assert.deepEqual(vnode.children, []);
});

test("evaluate passes an already-built VNode default export straight through", () => {
  const engine = createProgramEngine("quickjs-ng", (specifier) => {
    assert.equal(specifier, "@tsx-lvgl/core");
    return core as unknown as Record<string, unknown>;
  });
  const source = encode(`
    const lib = require("@tsx-lvgl/core");
    exports.default = lib.createVNode(lib.Text, { text: "x" });
  `);
  const vnode = engine.evaluate(source, manifest());
  assert.equal(vnode.kind, "element");
  assert.equal(vnode.type, "Text");
  assert.equal(vnode.props.text, "x");
});

test("evaluate throws when the bundle has no default export", () => {
  const engine = createProgramEngine("quickjs-ng", throwingResolver);
  const source = encode("exports.notDefault = 1;");
  assert.throws(
    () => engine.evaluate(source, manifest()),
    /bundle default export must be a component or VNode/,
  );
});

test("evaluate throws when the default export is neither a function nor a VNode", () => {
  const engine = createProgramEngine("quickjs-ng", throwingResolver);
  const source = encode("exports.default = { not: 'a vnode' };");
  assert.throws(
    () => engine.evaluate(source, manifest()),
    /bundle default export must be a component or VNode/,
  );
});

test("evaluate's require calls the resolver with the exact specifier", () => {
  const seen: string[] = [];
  const engine = createProgramEngine("quickjs-ng", (specifier) => {
    seen.push(specifier);
    return { value: 42 };
  });
  const source = encode(`
    require("@tsx-lvgl/sensors");
    exports.default = function App() { return null; };
  `);
  engine.evaluate(source, manifest());
  assert.deepEqual(seen, ["@tsx-lvgl/sensors"]);
});

test("an unresolved specifier's error propagates out of evaluate uncaught", () => {
  const engine = createProgramEngine("quickjs-ng", throwingResolver);
  const source = encode('require("nope");');
  assert.throws(() => engine.evaluate(source, manifest()), /unknown module: nope/);
});

test("a bundle that throws during evaluation propagates the error uncaught", () => {
  const engine = createProgramEngine("quickjs-ng", throwingResolver);
  const source = encode("throw new Error('top-level failure');");
  assert.throws(() => engine.evaluate(source, manifest()), /top-level failure/);
});

test("a hand-written CJS bundle mounts through a real Runtime and renders the expected tree", () => {
  const { host, runtime } = createHarness();
  const resolver: ModuleResolver = (specifier) => {
    if (specifier === "@tsx-lvgl/core") return core as unknown as Record<string, unknown>;
    throw new Error(`unknown module: ${specifier}`);
  };
  const engine = createProgramEngine("quickjs-ng", resolver);
  const source = encode(`
    const lib = require("@tsx-lvgl/core");
    exports.default = function App() {
      return lib.createVNode(lib.Screen, null, [lib.createVNode(lib.Text, { text: "hi" })]);
    };
  `);

  runtime.mount(engine.evaluate(source, manifest()));
  assert.equal(host.text(), "hi");
  runtime.unmount();
});

test("a throwing bundle staged through Runtime.reloadBundle rolls back and leaves the tree unchanged", () => {
  const { host, runtime } = createHarness();
  const resolver: ModuleResolver = (specifier) => {
    if (specifier === "@tsx-lvgl/core") return core as unknown as Record<string, unknown>;
    throw new Error(`unknown module: ${specifier}`);
  };
  const engine = createProgramEngine("quickjs-ng", resolver);
  const stableSource = encode(`
    const lib = require("@tsx-lvgl/core");
    exports.default = function App() { return lib.createVNode(lib.Text, { text: "stable" }); };
  `);
  runtime.mount(engine.evaluate(stableSource, manifest()));
  assert.equal(host.text(), "stable");

  const badSource = encode("throw new Error('bad bundle');");
  const policy: RuntimeBundlePolicy = {
    protocolVersion: 1,
    engine: "quickjs-ng",
    boardId: "esp32s3-waveshare-v1",
    maxBytes: 1024,
    lastGeneration: 1,
  };
  const result = runtime.reloadBundle(
    { manifest: manifest({ generation: 2, byteLength: badSource.byteLength }), source: badSource },
    policy,
    engine,
  );
  assert.equal(result.status, "rolled_back");
  assert.equal(host.text(), "stable");
  runtime.unmount();
});
