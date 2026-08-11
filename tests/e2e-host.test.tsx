/**
 * The MVP-promise test: a real TSX app, compiled through the real
 * `compileTsxBundle`, mounted and hot-reloaded through a real `createKernel`
 * — over the `NativeBindings` fakes from `tests/support/fake-native.ts`. No
 * mocking of the bundler or the kernel themselves.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BOARD_ID, PROTOCOL_VERSION, compileTsxBundle, type BundleOutput } from "@tsx-lvgl/bundler";
import { NATIVE_STYLE_PROP, createKernel } from "@tsx-lvgl/device";
import {
  RUNTIME_BUNDLE_MAX_BYTES,
  validateRuntimeBundle,
  type RuntimeBundle,
} from "@tsx-lvgl/runtime";
import { makeFakeNative } from "./support/fake-native.js";

// Compiled test files live at test-dist/tests/e2e-host.test.js; two hops up
// from there is the repo root regardless of the cwd `node --test` runs from.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const shakeFaceSource = readFileSync(join(repoRoot, "tests/fixtures/shakeface-a.tsx"), "utf8");
const shakeFaceBSource = readFileSync(join(repoRoot, "tests/fixtures/shakeface-b.tsx"), "utf8");
const embeddedShakeFaceDirectory = join(repoRoot, "examples/esp-idf/runtime_port_probe/main");

const shakeMotion = { accelerationMps2: [30, 0, 0] as const, angularVelocityDps: [0, 0, 0] as const };

function compileShakeFace(generation: number): BundleOutput {
  return compileTsxBundle({
    fileName: "ShakeFace.tsx",
    source: shakeFaceSource,
    bundleId: "shakeface",
    boardId: BOARD_ID,
    generation,
  });
}

/** Mirrors `scripts/bundle-app.mjs`, which publishes the SDK JSX runtime into the embedded generation-one app. */
function compileEmbeddedShakeFace(generation: number): BundleOutput {
  return compileTsxBundle({
    fileName: "ShakeFace.tsx",
    source: shakeFaceSource,
    bundleId: "shakeface",
    boardId: BOARD_ID,
    generation,
    jsxImportSource: "@tsx-lvgl/sdk",
  });
}

function compileShakeFaceB(generation: number): BundleOutput {
  return compileTsxBundle({
    fileName: "shakeface-b.tsx",
    source: shakeFaceBSource,
    bundleId: "shakeface",
    boardId: BOARD_ID,
    generation,
  });
}

function toBundle(output: BundleOutput): RuntimeBundle {
  return { manifest: output.manifest, source: output.bytes };
}

/** A fresh kernel over a fake board transport. */
function startedKernel() {
  const fake = makeFakeNative(BOARD_ID);
  const kernel = createKernel(fake.native);
  kernel.start(toBundle(compileShakeFace(1)));
  return { fake, kernel };
}

function buttonId(fake: ReturnType<typeof makeFakeNative>): number {
  const [id] = fake.lvgl.liveIdsOfKind("button");
  assert.ok(id, "expected a live button widget");
  return id;
}

test("bundle A compiles, validates, and mounts: eyes, happy mouth, status, and button render", () => {
  const output = compileShakeFace(1);
  const validation = validateRuntimeBundle(
    { manifest: output.manifest, source: output.bytes },
    {
      protocolVersion: PROTOCOL_VERSION,
      engine: "quickjs-ng",
      boardId: BOARD_ID,
      maxBytes: RUNTIME_BUNDLE_MAX_BYTES,
      lastGeneration: 0,
    },
  );
  assert.equal(validation.ok, true);

  const fake = makeFakeNative(BOARD_ID);
  const kernel = createKernel(fake.native);
  kernel.start(toBundle(output));

  assert.deepEqual(fake.lvgl.liveTexts(), ["O    O", "\\____/", "felice - scuotimi"]);
  const id = buttonId(fake);
  assert.equal(fake.lvgl.textOf(id), "switch: sad");
});

test("a shake flips the mouth, a second shake within the cooldown is ignored, and one after cooldown flips back", async () => {
  const { fake, kernel } = startedKernel();
  await Promise.resolve();
  await Promise.resolve();
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["O    O", "\\____/", "felice - scuotimi"]);

  // First shake: flips to sad. The state flip is one render cycle behind the
  // sample update (useEffect -> setState is its own deferred render task), so
  // pump twice: once to accept the sample, once to flush the resulting toggle.
  fake.emitMotion({ status: "ok", sampledAtMs: 80, value: shakeMotion });
  kernel.pump();
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["O    O", "/----\\", "triste - scuotimi"]);

  // Second shake 80ms later (well within the 700ms cooldown): ignored.
  fake.emitMotion({ status: "ok", sampledAtMs: 160, value: shakeMotion });
  kernel.pump();
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["O    O", "/----\\", "triste - scuotimi"]);

  // A shake at t=860ms (>= 80 + 700ms cooldown): accepted, flips back to happy.
  fake.emitMotion({ status: "ok", sampledAtMs: 860, value: shakeMotion });
  kernel.pump();
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["O    O", "\\____/", "felice - scuotimi"]);
});

test("clicking the button flips the mood manually", () => {
  const { fake, kernel } = startedKernel();
  const id = buttonId(fake);

  fake.dispatchClick(id);
  kernel.pump();

  assert.deepEqual(fake.lvgl.liveTexts(), ["O    O", "/----\\", "triste - scuotimi"]);
  assert.equal(fake.lvgl.textOf(id), "switch: happy");
});

test("an unavailable IMU reading reports the Italian unavailable status", async () => {
  const fake = makeFakeNative(BOARD_ID);
  const kernel = createKernel(fake.native);
  kernel.start(toBundle(compileShakeFace(1)));
  fake.emitMotion({ status: "unavailable", sampledAtMs: 0 });

  await Promise.resolve();
  await Promise.resolve();
  kernel.pump();

  assert.deepEqual(fake.lvgl.liveTexts(), ["O    O", "\\____/", "IMU non disponibile"]);
});

test("a hot reload to variant B commits, swaps the tree, and disposes the old instances", () => {
  const { fake, kernel } = startedKernel();
  const oldIds = [...fake.lvgl.liveIdsOfKind("text"), ...fake.lvgl.liveIdsOfKind("button")];
  assert.ok(oldIds.length > 0);

  const bundleB = compileShakeFaceB(2);
  const result = kernel.stageReload(JSON.stringify(bundleB.manifest), bundleB.code);

  assert.equal(result, "committed 2");
  assert.deepEqual(fake.lvgl.liveTexts(), ["O    O", "^----^", "B: felice - scuotimi"]);
  const id = buttonId(fake);
  assert.equal(fake.lvgl.textOf(id), "switch: sad");
  for (const oldId of oldIds) assert.equal(fake.lvgl.isAlive(oldId), false, `instance ${oldId} must be disposed`);
});

test("a byte-corrupted reload is rejected and the mounted tree is untouched", () => {
  const { fake, kernel } = startedKernel();
  const before = fake.lvgl.liveTexts();

  const bundleB = compileShakeFaceB(2);
  const truncated = bundleB.code.slice(0, Math.floor(bundleB.code.length / 2));
  const result = kernel.stageReload(JSON.stringify(bundleB.manifest), truncated);

  assert.equal(result, "rejected byte-length-mismatch");
  assert.deepEqual(fake.lvgl.liveTexts(), before);
});

test("a throwing candidate rolls back and the previous app stays mounted and interactive", () => {
  const { fake, kernel } = startedKernel();
  const before = fake.lvgl.liveTexts();

  const throwingSource = 'export default function Boom() {\n  throw new Error("boom");\n}\n';
  const throwingBundle = compileTsxBundle({
    fileName: "Boom.tsx",
    source: throwingSource,
    bundleId: "shakeface",
    boardId: BOARD_ID,
    generation: 2,
  });
  const result = kernel.stageReload(JSON.stringify(throwingBundle.manifest), throwingBundle.code);

  assert.equal(result, "rolled_back");
  assert.deepEqual(fake.lvgl.liveTexts(), before);

  // Still interactive: the click handler still fires...
  const id = buttonId(fake);
  fake.dispatchClick(id);
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["O    O", "/----\\", "triste - scuotimi"]);

  // ...and the board observation still advances and re-renders.
  fake.emitMotion({ status: "ok", sampledAtMs: 800, value: shakeMotion });
  kernel.pump();
  kernel.pump();
  assert.deepEqual(fake.lvgl.liveTexts(), ["O    O", "\\____/", "felice - scuotimi"]);
});

test("compiling ShakeFace twice is byte-for-byte and manifest-for-manifest deterministic", () => {
  const first = compileShakeFace(1);
  const second = compileShakeFace(1);
  assert.deepEqual([...first.bytes], [...second.bytes]);
  assert.deepEqual(first.manifest, second.manifest);
});

const styledSource = `
  import { Button, Screen, Text, useState } from "@tsx-lvgl/sdk";
  export default function Styled() {
    const [step, setStep] = useState(0);
    const style = step === 0
      ? { backgroundColor: "red", borderWidth: 1 }
      : step === 1
        ? { backgroundColor: "red", borderWidth: 2 }
        : { backgroundColor: "red" };
    return (
      <Screen>
        <Text text="styled" style={style} />
        <Button label="next" onClick={() => setStep((current) => current + 1)} />
      </Screen>
    );
  }
`;

test("a styled component render, changing one style key emits exactly one setStyle, and removing a key emits exactly one resetStyle", () => {
  const output = compileTsxBundle({
    fileName: "Styled.tsx",
    source: styledSource,
    bundleId: "styled",
    boardId: BOARD_ID,
    generation: 1,
    jsxImportSource: "@tsx-lvgl/sdk",
  });
  const fake = makeFakeNative(BOARD_ID);
  const kernel = createKernel(fake.native);
  kernel.start(toBundle(output));

  const [textId] = fake.lvgl.liveIdsOfKind("text");
  const [clickableId] = fake.lvgl.liveIdsOfKind("button");
  assert.ok(textId, "expected a live text widget");
  assert.ok(clickableId, "expected a live button widget");
  assert.equal(fake.lvgl.styleOf(textId, NATIVE_STYLE_PROP.borderWidth), 1);

  const setBeforeFirstClick = fake.lvgl.setStyleCalls.length;
  fake.dispatchClick(clickableId);
  kernel.pump();
  const emittedOnFirstClick = fake.lvgl.setStyleCalls.slice(setBeforeFirstClick);
  assert.deepEqual(emittedOnFirstClick, [{ id: textId, prop: NATIVE_STYLE_PROP.borderWidth, value: 2 }]);

  const setBeforeSecondClick = fake.lvgl.setStyleCalls.length;
  const resetBeforeSecondClick = fake.lvgl.resetStyleCalls.length;
  fake.dispatchClick(clickableId);
  kernel.pump();
  assert.equal(fake.lvgl.setStyleCalls.length, setBeforeSecondClick, "backgroundColor is unchanged, so no setStyle");
  assert.deepEqual(
    fake.lvgl.resetStyleCalls.slice(resetBeforeSecondClick),
    [{ id: textId, prop: NATIVE_STYLE_PROP.borderWidth }],
  );
});

const sizedSource = `
  import { Button, Screen, Text, useState } from "@tsx-lvgl/sdk";
  export default function Sized() {
    const [step, setStep] = useState(0);
    const style = step === 0 ? { width: "50%" } : { width: 120 };
    return (
      <Screen>
        <Text text="sized" style={style} />
        <Button label="next" onClick={() => setStep((current) => current + 1)} />
      </Screen>
    );
  }
`;

test("a width style re-rendered from percent to px emits a single setStyle per change, encoded per the S2 ABI", () => {
  const output = compileTsxBundle({
    fileName: "Sized.tsx",
    source: sizedSource,
    bundleId: "sized",
    boardId: BOARD_ID,
    generation: 1,
    jsxImportSource: "@tsx-lvgl/sdk",
  });
  const fake = makeFakeNative(BOARD_ID);
  const kernel = createKernel(fake.native);
  kernel.start(toBundle(output));

  const [textId] = fake.lvgl.liveIdsOfKind("text");
  const [clickableId] = fake.lvgl.liveIdsOfKind("button");
  assert.ok(textId, "expected a live text widget");
  assert.ok(clickableId, "expected a live button widget");
  assert.equal(fake.lvgl.styleOf(textId, NATIVE_STYLE_PROP.width), -51);

  const setBefore = fake.lvgl.setStyleCalls.length;
  fake.dispatchClick(clickableId);
  kernel.pump();
  const emitted = fake.lvgl.setStyleCalls.slice(setBefore);
  assert.deepEqual(emitted, [{ id: textId, prop: NATIVE_STYLE_PROP.width, value: 120 }]);
});

const flexSource = `
  import { Button, Screen, Text, View, useState } from "@tsx-lvgl/sdk";
  export default function Flex() {
    const [step, setStep] = useState(0);
    const style = step === 0
      ? { flexDirection: "row", gap: 4 }
      : { flexDirection: "column", gap: 4 };
    return (
      <Screen>
        <View style={style}>
          <Text text="flex" />
        </View>
        <Button label="next" onClick={() => setStep((current) => current + 1)} />
      </Screen>
    );
  }
`;

test("a flex row with gap, re-rendered to column, emits a single setStyle(flexDirection, 1)", () => {
  const output = compileTsxBundle({
    fileName: "Flex.tsx",
    source: flexSource,
    bundleId: "flex",
    boardId: BOARD_ID,
    generation: 1,
    jsxImportSource: "@tsx-lvgl/sdk",
  });
  const fake = makeFakeNative(BOARD_ID);
  const kernel = createKernel(fake.native);
  kernel.start(toBundle(output));

  const [viewId] = fake.lvgl.liveIdsOfKind("view");
  const [clickableId] = fake.lvgl.liveIdsOfKind("button");
  assert.ok(viewId, "expected a live view widget");
  assert.ok(clickableId, "expected a live button widget");
  assert.equal(fake.lvgl.styleOf(viewId, NATIVE_STYLE_PROP.flexDirection), 0);
  assert.equal(fake.lvgl.styleOf(viewId, NATIVE_STYLE_PROP.gap), 4);

  const setBefore = fake.lvgl.setStyleCalls.length;
  fake.dispatchClick(clickableId);
  kernel.pump();
  const emitted = fake.lvgl.setStyleCalls.slice(setBefore);
  assert.deepEqual(emitted, [{ id: viewId, prop: NATIVE_STYLE_PROP.flexDirection, value: 1 }]);
});

test("embedded ShakeFace generation one exactly matches the canonical board-capability fixture", () => {
  const generated = compileEmbeddedShakeFace(1);
  assert.equal(readFileSync(join(embeddedShakeFaceDirectory, "shakeface.g1.js"), "utf8"), generated.code);
  assert.deepEqual(
    JSON.parse(readFileSync(join(embeddedShakeFaceDirectory, "shakeface.g1.manifest.json"), "utf8")),
    generated.manifest,
  );
});
