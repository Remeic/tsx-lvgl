import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NATIVE_STYLE_PROP, applyStyleDiff, normalizeStyle } from "@tsx-lvgl/device";
import { FakeNativeLvgl } from "./support/fake-native.js";

const P = NATIVE_STYLE_PROP;

// ---------------------------------------------------------------------------
// normalizeStyle: absent/empty input
// ---------------------------------------------------------------------------

test("undefined, null and an empty object all normalize to an empty map", () => {
  assert.equal(normalizeStyle(undefined).size, 0);
  assert.equal(normalizeStyle(null).size, 0);
  assert.equal(normalizeStyle({}).size, 0);
});

// ---------------------------------------------------------------------------
// colors
// ---------------------------------------------------------------------------

test("a concrete hex backgroundColor normalizes to its RGB int under the backgroundColor code", () => {
  const style = normalizeStyle({ backgroundColor: "#ff0000" });
  assert.equal(style.get(P.backgroundColor), 0xff0000);
});

test("hex colors are case-insensitive", () => {
  assert.equal(normalizeStyle({ color: "#AbCdEf" }).get(P.color), 0xabcdef);
});

test("every named color resolves to its fixed RGB int", () => {
  const named: Record<string, number> = {
    red: 0xff0000,
    green: 0x008000,
    blue: 0x0000ff,
    black: 0x000000,
    white: 0xffffff,
    gray: 0x808080,
    yellow: 0xffff00,
    cyan: 0x00ffff,
    magenta: 0xff00ff,
  };
  for (const [name, value] of Object.entries(named)) {
    assert.equal(normalizeStyle({ borderColor: name }).get(P.borderColor), value, name);
  }
});

test("transparent is skipped, matching the absent-is-transparent baseline", () => {
  assert.equal(normalizeStyle({ backgroundColor: "transparent" }).has(P.backgroundColor), false);
});

test("invalid colors are skipped silently: bad hex length, bad hex chars, unknown name, non-string", () => {
  assert.equal(normalizeStyle({ backgroundColor: "#fff" }).has(P.backgroundColor), false);
  assert.equal(normalizeStyle({ backgroundColor: "#gggggg" }).has(P.backgroundColor), false);
  assert.equal(normalizeStyle({ backgroundColor: "orange" }).has(P.backgroundColor), false);
  assert.equal(normalizeStyle({ backgroundColor: 123 as unknown as string }).has(P.backgroundColor), false);
});

// ---------------------------------------------------------------------------
// number keys: borderWidth, borderRadius, per-side padding
// ---------------------------------------------------------------------------

test("borderWidth and borderRadius round to the nearest integer", () => {
  assert.equal(normalizeStyle({ borderWidth: 2.6 }).get(P.borderWidth), 3);
  assert.equal(normalizeStyle({ borderRadius: 4.4 }).get(P.borderRadius), 4);
});

test("NaN and Infinity are skipped", () => {
  assert.equal(normalizeStyle({ borderWidth: Number.NaN }).has(P.borderWidth), false);
  assert.equal(normalizeStyle({ borderWidth: Number.POSITIVE_INFINITY }).has(P.borderWidth), false);
  assert.equal(normalizeStyle({ borderWidth: Number.NEGATIVE_INFINITY }).has(P.borderWidth), false);
});

test("negative padding, borderWidth and borderRadius are skipped", () => {
  assert.equal(normalizeStyle({ borderWidth: -1 }).has(P.borderWidth), false);
  assert.equal(normalizeStyle({ borderRadius: -1 }).has(P.borderRadius), false);
  assert.equal(normalizeStyle({ paddingTop: -1 }).has(P.paddingTop), false);
});

test("zero is a valid non-negative value", () => {
  assert.equal(normalizeStyle({ borderWidth: 0 }).get(P.borderWidth), 0);
});

test("each per-side padding key writes its own code", () => {
  const style = normalizeStyle({ paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4 });
  assert.equal(style.get(P.paddingTop), 1);
  assert.equal(style.get(P.paddingRight), 2);
  assert.equal(style.get(P.paddingBottom), 3);
  assert.equal(style.get(P.paddingLeft), 4);
});

// ---------------------------------------------------------------------------
// padding shorthand precedence: padding < axis < side
// ---------------------------------------------------------------------------

test("padding shorthand fans out to all four sides", () => {
  const style = normalizeStyle({ padding: 5 });
  assert.equal(style.get(P.paddingTop), 5);
  assert.equal(style.get(P.paddingRight), 5);
  assert.equal(style.get(P.paddingBottom), 5);
  assert.equal(style.get(P.paddingLeft), 5);
});

test("paddingHorizontal/paddingVertical override padding on their axis only", () => {
  const style = normalizeStyle({ padding: 1, paddingHorizontal: 2, paddingVertical: 3 });
  assert.equal(style.get(P.paddingTop), 3);
  assert.equal(style.get(P.paddingRight), 2);
  assert.equal(style.get(P.paddingBottom), 3);
  assert.equal(style.get(P.paddingLeft), 2);
});

test("a per-side key overrides both padding and the axis shorthand", () => {
  const style = normalizeStyle({ padding: 1, paddingHorizontal: 2, paddingTop: 3 });
  assert.equal(style.get(P.paddingTop), 3, "paddingTop wins over padding and paddingHorizontal");
  assert.equal(style.get(P.paddingRight), 2, "paddingHorizontal still wins over padding on the right");
  assert.equal(style.get(P.paddingBottom), 1, "padding is the only source for bottom");
  assert.equal(style.get(P.paddingLeft), 2, "paddingHorizontal still wins over padding on the left");
});

// ---------------------------------------------------------------------------
// textAlign
// ---------------------------------------------------------------------------

test("textAlign maps left/center/right to 0/1/2", () => {
  assert.equal(normalizeStyle({ textAlign: "left" }).get(P.textAlign), 0);
  assert.equal(normalizeStyle({ textAlign: "center" }).get(P.textAlign), 1);
  assert.equal(normalizeStyle({ textAlign: "right" }).get(P.textAlign), 2);
});

test("an unrecognized textAlign is skipped", () => {
  assert.equal(normalizeStyle({ textAlign: "justify" as unknown as "left" }).has(P.textAlign), false);
});

// ---------------------------------------------------------------------------
// unknown keys, arrays
// ---------------------------------------------------------------------------

test("unknown keys are ignored", () => {
  const style = normalizeStyle({ backgroundColor: "red", somethingElse: 42 });
  assert.equal(style.size, 1);
  assert.equal(style.get(P.backgroundColor), 0xff0000);
});

test("array styles skip falsy entries and merge with later entries winning", () => {
  const style = normalizeStyle([
    { backgroundColor: "red", borderWidth: 1 },
    false,
    null,
    undefined,
    { backgroundColor: "blue" },
  ]);
  assert.equal(style.get(P.backgroundColor), 0x0000ff, "the later object's backgroundColor wins");
  assert.equal(style.get(P.borderWidth), 1, "a key absent from the later object is kept from the earlier one");
});

// ---------------------------------------------------------------------------
// width/height (S2)
// ---------------------------------------------------------------------------

test("width and height accept non-negative px, rounded", () => {
  const style = normalizeStyle({ width: 10.4, height: 20.6 });
  assert.equal(style.get(P.width), 10);
  assert.equal(style.get(P.height), 21);
});

test("negative px width/height is skipped", () => {
  assert.equal(normalizeStyle({ width: -1 }).has(P.width), false);
});

test("percent strings encode as -(N + 1), rounded", () => {
  assert.equal(normalizeStyle({ width: "50%" }).get(P.width), -51);
  assert.equal(normalizeStyle({ width: "0%" }).get(P.width), -1);
  assert.equal(normalizeStyle({ width: "100%" }).get(P.width), -101);
});

test("percent above 1000 clamps to 1000 before encoding", () => {
  assert.equal(normalizeStyle({ width: "2000%" }).get(P.width), -1001);
});

test('"auto" encodes as -2000', () => {
  assert.equal(normalizeStyle({ width: "auto" }).get(P.width), -2000);
  assert.equal(normalizeStyle({ height: "auto" }).get(P.height), -2000);
});

test("an invalid dimension string or NaN is skipped", () => {
  assert.equal(normalizeStyle({ width: "abc%" }).has(P.width), false);
  assert.equal(normalizeStyle({ width: "big" }).has(P.width), false, "not a percent string and not \"auto\"");
  assert.equal(normalizeStyle({ width: Number.NaN }).has(P.width), false);
});

// ---------------------------------------------------------------------------
// left/top (S2)
// ---------------------------------------------------------------------------

test("left and top accept any finite number, rounded, negatives preserved", () => {
  const style = normalizeStyle({ left: -4, top: 2.6 });
  assert.equal(style.get(P.left), -4);
  assert.equal(style.get(P.top), 3);
});

test("non-finite left/top is skipped", () => {
  assert.equal(normalizeStyle({ left: Number.NaN }).has(P.left), false);
  assert.equal(normalizeStyle({ top: Number.POSITIVE_INFINITY }).has(P.top), false);
});

// ---------------------------------------------------------------------------
// display (S2)
// ---------------------------------------------------------------------------

test("display maps none/flex to 1/0", () => {
  assert.equal(normalizeStyle({ display: "none" }).get(P.display), 1);
  assert.equal(normalizeStyle({ display: "flex" }).get(P.display), 0);
});

test("an unrecognized display is skipped", () => {
  assert.equal(normalizeStyle({ display: "block" as unknown as "flex" }).has(P.display), false);
});

// ---------------------------------------------------------------------------
// position (S2, no-op)
// ---------------------------------------------------------------------------

test("position emits nothing for either accepted value", () => {
  assert.equal(normalizeStyle({ position: "absolute" }).size, 0);
  assert.equal(normalizeStyle({ position: "relative" }).size, 0);
});

// ---------------------------------------------------------------------------
// applyStyleDiff
// ---------------------------------------------------------------------------

test("applyStyleDiff calls setStyle with the exact prop code and value for a fresh style", () => {
  const lvgl = new FakeNativeLvgl();
  const id = lvgl.create("view");
  const style = normalizeStyle({ backgroundColor: "#ff0000" });
  applyStyleDiff(lvgl, id, new Map(), style);
  assert.deepEqual(lvgl.setStyleCalls, [{ id, prop: P.backgroundColor, value: 0xff0000 }]);
  assert.deepEqual(lvgl.resetStyleCalls, []);
});

test("applyStyleDiff emits setStyle only for keys whose value actually changed", () => {
  const lvgl = new FakeNativeLvgl();
  const id = lvgl.create("view");
  const previous = normalizeStyle({ backgroundColor: "red", borderWidth: 2 });
  const next = normalizeStyle({ backgroundColor: "red", borderWidth: 3 });
  applyStyleDiff(lvgl, id, previous, next);
  assert.deepEqual(lvgl.setStyleCalls, [{ id, prop: P.borderWidth, value: 3 }]);
});

test("applyStyleDiff resets keys present in previous but absent from next", () => {
  const lvgl = new FakeNativeLvgl();
  const id = lvgl.create("view");
  const previous = normalizeStyle({ backgroundColor: "red", borderWidth: 2 });
  const next = normalizeStyle({ backgroundColor: "red" });
  applyStyleDiff(lvgl, id, previous, next);
  assert.deepEqual(lvgl.resetStyleCalls, [{ id, prop: P.borderWidth }]);
});

test("applyStyleDiff is a no-op for two normalizations of the same style content", () => {
  const lvgl = new FakeNativeLvgl();
  const id = lvgl.create("view");
  const previous = normalizeStyle({ backgroundColor: "red", padding: 4 });
  const next = normalizeStyle({ backgroundColor: "red", padding: 4 });
  applyStyleDiff(lvgl, id, previous, next);
  assert.deepEqual(lvgl.setStyleCalls, []);
  assert.deepEqual(lvgl.resetStyleCalls, []);
});

test("a px-to-percent width transition diffs as exactly one setStyle, never a reset (same code, both forms)", () => {
  const lvgl = new FakeNativeLvgl();
  const id = lvgl.create("view");
  const previous = normalizeStyle({ width: 120 });
  const next = normalizeStyle({ width: "50%" });
  applyStyleDiff(lvgl, id, previous, next);
  assert.deepEqual(lvgl.setStyleCalls, [{ id, prop: P.width, value: -51 }]);
  assert.deepEqual(lvgl.resetStyleCalls, []);
});

test("applyStyleDiff against an empty previous emits a setStyle per next entry, in the fixed key order", () => {
  const lvgl = new FakeNativeLvgl();
  const id = lvgl.create("view");
  const next = normalizeStyle({ color: "blue", padding: 1, textAlign: "center" });
  applyStyleDiff(lvgl, id, new Map(), next);
  assert.deepEqual(
    lvgl.setStyleCalls.map((call) => call.prop),
    [P.paddingTop, P.paddingRight, P.paddingBottom, P.paddingLeft, P.color, P.textAlign],
  );
});
