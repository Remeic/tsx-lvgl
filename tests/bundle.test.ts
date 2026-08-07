import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Screen, Text, createVNode, type VNode } from "@tsx-lvgl/core";
import { Runtime, validateRuntimeBundle, type RuntimeEngine } from "@tsx-lvgl/runtime";
import { FakeHost, ManualScheduler, createHarness } from "./support/harness.js";

function screen(text?: string): VNode {
  return createVNode(Screen, null, text === undefined ? [] : [createVNode(Text, { text })]);
}

test("bundle staging rejects malformed, stale, mismatched, and oversized generations", () => {
  const policy = {
    protocolVersion: 1,
    engine: "quickjs-ng" as const,
    boardId: "esp32s3-waveshare-v1" as const,
    maxBytes: 32,
    lastGeneration: 4,
  };
  const manifest = {
    bundleId: "counter-5",
    format: "js" as const,
    engine: "quickjs-ng" as const,
    protocolVersion: 1,
    boardId: "esp32s3-waveshare-v1" as const,
    generation: 5,
    sha256: "a".repeat(64),
    byteLength: 3,
  };

  const source = new Uint8Array([1, 2, 3]);
  const accepted = validateRuntimeBundle({ manifest, source }, policy);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.notEqual(accepted.bundle.source, source);
    assert.deepEqual(accepted.bundle.manifest, manifest);
    assert.deepEqual([...accepted.bundle.source], [1, 2, 3]);
  }
  const acceptedBytecode = validateRuntimeBundle(
    { manifest: { ...manifest, format: "bytecode" }, source: new Uint8Array([1, 2, 3]) },
    policy,
  );
  assert.equal(acceptedBytecode.ok, true);

  const cases = [
    ["empty-bundle-id", { ...manifest, bundleId: "" }],
    ["unsupported-format", { ...manifest, format: "json" }],
    ["engine-mismatch", { ...manifest, engine: "moddable-xs" }],
    ["protocol-mismatch", { ...manifest, protocolVersion: 2 }],
    ["generation-not-monotonic", { ...manifest, generation: 4 }],
    ["board-mismatch", { ...manifest, boardId: "other-board" }],
    ["invalid-hash", { ...manifest, sha256: "bad" }],
    ["invalid-hash", { ...manifest, sha256: `${"a".repeat(64)}x` }],
    ["invalid-hash", { ...manifest, sha256: `x${"a".repeat(64)}` }],
    ["byte-length-mismatch", { ...manifest, byteLength: 4 }],
    ["bundle-too-large", { ...manifest, byteLength: 33 }],
  ] as const;
  for (const [reason, invalidManifest] of cases) {
    const result = validateRuntimeBundle({ manifest: invalidManifest as unknown as typeof manifest, source: new Uint8Array(33) }, policy);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, reason);
  }
  const atLimit = validateRuntimeBundle(
    { manifest: { ...manifest, byteLength: policy.maxBytes }, source: new Uint8Array(policy.maxBytes) },
    policy,
  );
  assert.equal(atLimit.ok, true);
});

test("runtime reloads a validated bundle through the replaceable engine seam", () => {
  const { host, runtime } = createHarness();
  runtime.mount(screen("old"));
  const source = new Uint8Array([7, 8]);
  const manifest = {
    bundleId: "counter-5",
    format: "js" as const,
    engine: "quickjs-ng" as const,
    protocolVersion: 1,
    boardId: "esp32s3-waveshare-v1",
    generation: 5,
    sha256: "a".repeat(64),
    byteLength: source.byteLength,
  };
  const policy = {
    protocolVersion: 1,
    engine: "quickjs-ng" as const,
    boardId: "esp32s3-waveshare-v1",
    maxBytes: 32,
    lastGeneration: 4,
  };
  let evaluatedSource: Uint8Array | undefined;
  let evaluatedManifest: string | undefined;
  const engine: RuntimeEngine = {
    name: "quickjs-ng",
    evaluate(nextSource, nextManifest): VNode {
      evaluatedSource = nextSource;
      evaluatedManifest = nextManifest.bundleId;
      return screen("new");
    },
  };

  const result = runtime.reloadBundle({ manifest, source }, policy, engine);
  assert.deepEqual(result, { status: "committed", epoch: 2 });
  assert.notEqual(evaluatedSource, source, "the engine receives staged bytes, not transport storage");
  assert.equal(evaluatedManifest, "counter-5");
  assert.equal(host.text(), "new");
  runtime.unmount();
});

test("bundle reload rejects invalid metadata and an engine mismatch before evaluation", () => {
  const runtime = new Runtime({ host: new FakeHost(), scheduler: new ManualScheduler() });
  const source = new Uint8Array([1]);
  const bundle = {
    manifest: {
      bundleId: "counter-5",
      format: "js" as const,
      engine: "quickjs-ng" as const,
      protocolVersion: 1,
      boardId: "esp32s3-waveshare-v1",
      generation: 5,
      sha256: "a".repeat(64),
      byteLength: source.byteLength,
    },
    source,
  };
  const policy = {
    protocolVersion: 1,
    engine: "quickjs-ng" as const,
    boardId: "esp32s3-waveshare-v1",
    maxBytes: 32,
    lastGeneration: 4,
  };
  let evaluations = 0;
  const engine: RuntimeEngine = {
    name: "moddable-xs",
    evaluate(): VNode {
      evaluations += 1;
      return screen();
    },
  };

  assert.deepEqual(
    runtime.reloadBundle({ ...bundle, manifest: { ...bundle.manifest, bundleId: "" } }, policy, engine),
    { status: "rejected", reason: "empty-bundle-id" },
  );
  assert.deepEqual(runtime.reloadBundle(bundle, policy, engine), { status: "rejected", reason: "engine-mismatch" });
  assert.equal(evaluations, 0);
});

test("bundle evaluator failures roll back without touching the active root", () => {
  const { host, runtime } = createHarness();
  runtime.mount(screen("stable"));
  const source = new Uint8Array([1]);
  const bundle = {
    manifest: {
      bundleId: "counter-5",
      format: "js" as const,
      engine: "quickjs-ng" as const,
      protocolVersion: 1,
      boardId: "esp32s3-waveshare-v1",
      generation: 5,
      sha256: "a".repeat(64),
      byteLength: source.byteLength,
    },
    source,
  };
  const policy = {
    protocolVersion: 1,
    engine: "quickjs-ng" as const,
    boardId: "esp32s3-waveshare-v1",
    maxBytes: 32,
    lastGeneration: 4,
  };
  const engine: RuntimeEngine = {
    name: "quickjs-ng",
    evaluate(): VNode {
      throw new Error("engine evaluation failed");
    },
  };

  const result = runtime.reloadBundle(bundle, policy, engine);
  assert.equal(result.status, "rolled_back");
  if (result.status === "rolled_back") assert.match(String(result.error), /engine evaluation failed/);
  assert.equal(host.text(), "stable");
  runtime.unmount();
});
