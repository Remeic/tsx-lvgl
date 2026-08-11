import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BOARD_ID, compileTsxBundle, type BundleOutput } from "@tsx-lvgl/bundler";
import { createKernel } from "@tsx-lvgl/device";
import type { RuntimeBundle } from "@tsx-lvgl/runtime";

import { makeFakeNative } from "./support/fake-native.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const counterPath = join(repoRoot, "examples/apps/counter.tsx");
const counterSource = readFileSync(counterPath, "utf8");
const calmMotion = { accelerationMps2: [0, 0, 9.80665] as const, angularVelocityDps: [0, 0, 0] as const };
const shakeMotion = { accelerationMps2: [30, 0, 0] as const, angularVelocityDps: [0, 0, 0] as const };

function compileCounter(source: string, generation: number): BundleOutput {
  return compileTsxBundle({
    fileName: "counter.tsx",
    source,
    bundleId: "counter",
    boardId: BOARD_ID,
    generation,
    jsxImportSource: "@tsx-lvgl/sdk",
  });
}

function toRuntimeBundle(output: BundleOutput): RuntimeBundle {
  return { manifest: output.manifest, source: output.bytes };
}

function buttonId(fake: ReturnType<typeof makeFakeNative>): number {
  const [id] = fake.lvgl.liveIdsOfKind("button");
  assert.ok(id, "expected Counter increment button");
  return id;
}

test("the golden Counter mounts, increments through touch, and exposes a motion state", () => {
  const fake = makeFakeNative(BOARD_ID);
  const kernel = createKernel(fake.native);
  kernel.start(toRuntimeBundle(compileCounter(counterSource, 1)));

  assert.deepEqual(fake.lvgl.liveTexts(), ["count=0", "motion=starting"]);
  fake.emitMotion({ status: "ok", sampledAtMs: 0, value: calmMotion });
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["count=0", "motion=STILL"]);

  fake.dispatchClick(buttonId(fake));
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["count=1", "motion=STILL"]);

  fake.emitMotion({ status: "ok", sampledAtMs: 80, value: shakeMotion });
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["count=1", "motion=SHAKE"]);
});

test("the golden Counter accepts a higher generation and keeps the last root after malformed, corrupt, and throwing candidates", () => {
  const fake = makeFakeNative(BOARD_ID);
  const kernel = createKernel(fake.native);
  kernel.start(toRuntimeBundle(compileCounter(counterSource, 1)));
  fake.emitMotion({ status: "ok", sampledAtMs: 0, value: calmMotion });
  kernel.pump();

  const replacementSource = `
    import { Button, Screen, Text, useMotion, useState, type VNode } from "@tsx-lvgl/sdk";
    export default function Replacement(): VNode {
      const [count, setCount] = useState(10);
      const motion = useMotion();
      const state = motion.state.status === "ready" || motion.state.status === "stale" ? "motion=LIVE" : "motion=" + motion.state.status;
      return <Screen><Text text={"replacement=" + count} /><Text text={state} /><Button label="increment" onClick={() => setCount((value) => value + 1)} /></Screen>;
    }
  `;
  const replacement = compileCounter(replacementSource, 2);
  assert.equal(kernel.stageReload(JSON.stringify(replacement.manifest), replacement.code), "committed 2");
  assert.equal(kernel.lastGeneration(), 2);
  const previousTexts = fake.lvgl.liveTexts();
  assert.deepEqual(previousTexts, ["replacement=10", "motion=LIVE"]);

  assert.equal(kernel.stageReload("{malformed", replacement.code), "rejected malformed-manifest");
  assert.equal(kernel.lastGeneration(), 2);
  assert.deepEqual(fake.lvgl.liveTexts(), previousTexts);

  const corrupt = compileCounter(counterSource, 3);
  assert.equal(kernel.stageReload(JSON.stringify(corrupt.manifest), corrupt.code.slice(0, Math.floor(corrupt.code.length / 2))), "rejected byte-length-mismatch");
  assert.equal(kernel.lastGeneration(), 2);
  assert.deepEqual(fake.lvgl.liveTexts(), previousTexts);

  const throwing = compileCounter("export default function Boom() { throw new Error(\"boom\"); }", 3);
  assert.equal(kernel.stageReload(JSON.stringify(throwing.manifest), throwing.code), "rolled_back");
  assert.equal(kernel.lastGeneration(), 2);
  assert.deepEqual(fake.lvgl.liveTexts(), previousTexts);
});

test("the embedded Counter bundle is generated from the canonical SDK entry", () => {
  const generated = compileCounter(counterSource, 1);
  const embeddedDirectory = join(repoRoot, "examples/esp-idf/runtime_port_probe/main");
  assert.equal(readFileSync(join(embeddedDirectory, "counter.g1.js"), "utf8"), generated.code);
  assert.deepEqual(JSON.parse(readFileSync(join(embeddedDirectory, "counter.g1.manifest.json"), "utf8")), generated.manifest);
});
