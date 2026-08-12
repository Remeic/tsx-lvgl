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

test("negative fractional non-negative values are skipped before rounding", () => {
  assert.equal(normalizeStyle({ padding: -0.1 }).has(P.paddingTop), false);
  assert.equal(normalizeStyle({ borderWidth: -0.1 }).has(P.borderWidth), false);
  assert.equal(normalizeStyle({ gap: -0.1 }).has(P.gap), false);
  assert.equal(normalizeStyle({ flex: -0.1 }).has(P.flexGrow), false);
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
  assert.equal(normalizeStyle({ width: "50oops%" }).has(P.width), false);
  assert.equal(normalizeStyle({ width: "50%oops" }).has(P.width), false);
  assert.equal(normalizeStyle({ width: " %" }).has(P.width), false);
  assert.equal(normalizeStyle({ width: "big" }).has(P.width), false, "not a percent string and not \"auto\"");
  assert.equal(normalizeStyle({ width: Number.NaN }).has(P.width), false);
});

test("unbounded encoded numbers outside signed int32 are skipped at the TS ABI boundary", () => {
  const max = 0x7fffffff;
  const min = -0x80000000;
  assert.equal(normalizeStyle({ width: max }).get(P.width), max);
  assert.equal(normalizeStyle({ width: max + 1 }).has(P.width), false);
  assert.equal(normalizeStyle({ left: min }).get(P.left), min);
  assert.equal(normalizeStyle({ left: min - 1 }).has(P.left), false);
  assert.equal(normalizeStyle({ scale: max / 256 }).get(P.scale), max);
  assert.equal(normalizeStyle({ scale: (max + 1) / 256 }).has(P.scale), false);
  assert.equal(normalizeStyle({ rotate: max / 10 }).get(P.rotate), max);
  assert.equal(normalizeStyle({ rotate: (max + 1) / 10 }).has(P.rotate), false);
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
// opacity / rotate / scale (S4)
// ---------------------------------------------------------------------------

test("opacity, rotate, scale and fontSize codes are 20/21/22/23 in order", () => {
  assert.equal(P.opacity, 20);
  assert.equal(P.rotate, 21);
  assert.equal(P.scale, 22);
  assert.equal(P.fontSize, 23);
});

test("opacity scales 0/1/0.5 to 0/255/128 (0.5 * 255 = 127.5, rounds up)", () => {
  assert.equal(normalizeStyle({ opacity: 0 }).get(P.opacity), 0);
  assert.equal(normalizeStyle({ opacity: 1 }).get(P.opacity), 255);
  assert.equal(normalizeStyle({ opacity: 0.5 }).get(P.opacity), 128);
});

test("opacity clamps out-of-range finite values instead of skipping (CSS behavior)", () => {
  assert.equal(normalizeStyle({ opacity: 1.5 }).get(P.opacity), 255);
  assert.equal(normalizeStyle({ opacity: -0.2 }).get(P.opacity), 0);
});

test("non-finite or non-number opacity is skipped", () => {
  assert.equal(normalizeStyle({ opacity: Number.NaN }).has(P.opacity), false);
  assert.equal(normalizeStyle({ opacity: "0.5" as unknown as number }).has(P.opacity), false);
});

test("rotate accepts a number in degrees, scaled to deci-degrees, negatives preserved", () => {
  assert.equal(normalizeStyle({ rotate: 45 }).get(P.rotate), 450);
  assert.equal(normalizeStyle({ rotate: -90 }).get(P.rotate), -900);
});

test('rotate accepts a "${number}deg" string, scaled to deci-degrees', () => {
  assert.equal(normalizeStyle({ rotate: "45deg" }).get(P.rotate), 450);
  assert.equal(normalizeStyle({ rotate: "-12.34deg" }).get(P.rotate), -123);
});

test("a rotate string missing or misplacing the deg suffix is skipped", () => {
  assert.equal(normalizeStyle({ rotate: "45" as unknown as `${number}deg` }).has(P.rotate), false);
  assert.equal(normalizeStyle({ rotate: "deg" as unknown as `${number}deg` }).has(P.rotate), false);
  assert.equal(normalizeStyle({ rotate: "45degx" as unknown as `${number}deg` }).has(P.rotate), false);
});

test("non-finite rotate is skipped", () => {
  assert.equal(normalizeStyle({ rotate: Number.NaN }).has(P.rotate), false);
});

test("scale is finite number >= 0, scaled by 256 (LV_SCALE_NONE = 100%)", () => {
  assert.equal(normalizeStyle({ scale: 1 }).get(P.scale), 256);
  assert.equal(normalizeStyle({ scale: 1.2 }).get(P.scale), 307);
  assert.equal(normalizeStyle({ scale: 0 }).get(P.scale), 0);
  assert.equal(normalizeStyle({ scale: 2.5 }).get(P.scale), 640);
});

test("negative or non-finite scale is skipped", () => {
  assert.equal(normalizeStyle({ scale: -1 }).has(P.scale), false);
  assert.equal(normalizeStyle({ scale: Number.NaN }).has(P.scale), false);
});

test("fontSize accepts finite positive px, rounded", () => {
  assert.equal(normalizeStyle({ fontSize: 24 }).get(P.fontSize), 24);
  assert.equal(normalizeStyle({ fontSize: 24.4 }).get(P.fontSize), 24);
});

test("fontSize is omitted for view targets but retained for text targets", () => {
  const viewStyle = normalizeStyle({ backgroundColor: "red", fontSize: 24 }, "view");
  assert.equal(viewStyle.get(P.backgroundColor), 0xff0000);
  assert.equal(viewStyle.has(P.fontSize), false);
  assert.equal(normalizeStyle({ fontSize: 24 }, "text").get(P.fontSize), 24);
});

test("zero, negative, non-finite, non-number and int32-overflow fontSize values are skipped", () => {
  const invalid: readonly unknown[] = [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "24"];
  for (const value of invalid) {
    assert.equal(normalizeStyle({ fontSize: value as number }).has(P.fontSize), false, String(value));
  }
  assert.equal(normalizeStyle({ fontSize: 0x80000000 }).has(P.fontSize), false);
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

test("adding and removing fontSize emits one setStyle and one resetStyle at code 23", () => {
  const lvgl = new FakeNativeLvgl();
  const id = lvgl.create("text");
  applyStyleDiff(lvgl, id, normalizeStyle({}), normalizeStyle({ fontSize: 24.4 }));
  assert.deepEqual(lvgl.setStyleCalls, [{ id, prop: P.fontSize, value: 24 }]);

  applyStyleDiff(lvgl, id, normalizeStyle({ fontSize: 24 }), normalizeStyle({}));
  assert.deepEqual(lvgl.resetStyleCalls, [{ id, prop: P.fontSize }]);
});

// ---------------------------------------------------------------------------
// flexDirection / justifyContent / alignItems (S3)
// ---------------------------------------------------------------------------

test("flexDirection maps row/column/row-reverse/column-reverse to 0/1/2/3", () => {
  assert.equal(normalizeStyle({ flexDirection: "row" }).get(P.flexDirection), 0);
  assert.equal(normalizeStyle({ flexDirection: "column" }).get(P.flexDirection), 1);
  assert.equal(normalizeStyle({ flexDirection: "row-reverse" }).get(P.flexDirection), 2);
  assert.equal(normalizeStyle({ flexDirection: "column-reverse" }).get(P.flexDirection), 3);
});

test("an unrecognized flexDirection is skipped", () => {
  assert.equal(normalizeStyle({ flexDirection: "diagonal" as unknown as "row" }).has(P.flexDirection), false);
});

test("justifyContent maps flex-start/flex-end/center/space-between/space-around/space-evenly to 0..5", () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    ["flex-start", 0],
    ["flex-end", 1],
    ["center", 2],
    ["space-between", 3],
    ["space-around", 4],
    ["space-evenly", 5],
  ];
  for (const [value, code] of cases) {
    assert.equal(normalizeStyle({ justifyContent: value }).get(P.justifyContent), code, value);
  }
});

test("an unrecognized justifyContent is skipped", () => {
  assert.equal(normalizeStyle({ justifyContent: "stretch" as unknown as "center" }).has(P.justifyContent), false);
});

test("alignItems maps flex-start/flex-end/center to 0/1/2", () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    ["flex-start", 0],
    ["flex-end", 1],
    ["center", 2],
  ];
  for (const [value, code] of cases) {
    assert.equal(normalizeStyle({ alignItems: value }).get(P.alignItems), code, value);
  }
});

test("an unrecognized alignItems, including stretch (no LVGL equivalent), is skipped", () => {
  assert.equal(normalizeStyle({ alignItems: "stretch" as unknown as "center" }).has(P.alignItems), false);
});

// ---------------------------------------------------------------------------
// gap (S3)
// ---------------------------------------------------------------------------

test("gap accepts a non-negative number, rounded", () => {
  assert.equal(normalizeStyle({ gap: 4.6 }).get(P.gap), 5);
  assert.equal(normalizeStyle({ gap: 0 }).get(P.gap), 0);
});

test("negative or non-finite gap is skipped", () => {
  assert.equal(normalizeStyle({ gap: -1 }).has(P.gap), false);
  assert.equal(normalizeStyle({ gap: Number.NaN }).has(P.gap), false);
  assert.equal(normalizeStyle({ gap: Number.POSITIVE_INFINITY }).has(P.gap), false);
});

// ---------------------------------------------------------------------------
// flexGrow / flex alias (S3)
// ---------------------------------------------------------------------------

test("flexGrow accepts a finite number, rounded", () => {
  assert.equal(normalizeStyle({ flexGrow: 2.6 }).get(P.flexGrow), 3);
});

test("flexGrow clamps 256 to 255 (LVGL flex_grow is uint8)", () => {
  assert.equal(normalizeStyle({ flexGrow: 256 }).get(P.flexGrow), 255);
});

test("negative flexGrow is skipped", () => {
  assert.equal(normalizeStyle({ flexGrow: -1 }).has(P.flexGrow), false);
});

test("flex is an alias of flexGrow: it writes the same code 19, with the same clamp/round rules", () => {
  assert.equal(normalizeStyle({ flex: 1 }).get(P.flexGrow), 1);
  assert.equal(normalizeStyle({ flex: 2.6 }).get(P.flexGrow), 3);
  assert.equal(normalizeStyle({ flex: 256 }).get(P.flexGrow), 255);
  assert.equal(normalizeStyle({ flex: -1 }).has(P.flexGrow), false);
});

test("an explicit flexGrow wins over the flex alias, regardless of object key order", () => {
  assert.equal(normalizeStyle({ flex: 1, flexGrow: 2 }).get(P.flexGrow), 2);
  assert.equal(normalizeStyle({ flexGrow: 2, flex: 1 }).get(P.flexGrow), 2);
});

// ---------------------------------------------------------------------------
// implied flex (S3): justifyContent/alignItems/gap alone imply flexDirection: column
// ---------------------------------------------------------------------------

test("justifyContent, alignItems or gap alone each implies flexDirection column (code 15 = 1)", () => {
  assert.equal(normalizeStyle({ justifyContent: "center" }).get(P.flexDirection), 1);
  assert.equal(normalizeStyle({ alignItems: "center" }).get(P.flexDirection), 1);
  assert.equal(normalizeStyle({ gap: 4 }).get(P.flexDirection), 1);
});

test("an explicit flexDirection wins over the implied column", () => {
  assert.equal(normalizeStyle({ flexDirection: "row", justifyContent: "center" }).get(P.flexDirection), 0);
});

test("flexGrow/flex alone do not imply flexDirection: they're a child property, not a container setting", () => {
  assert.equal(normalizeStyle({ flexGrow: 1 }).has(P.flexDirection), false);
  assert.equal(normalizeStyle({ flex: 1 }).has(P.flexDirection), false);
});

test("removing the last implied-flex trigger key on re-render diffs away the implied flexDirection", () => {
  const lvgl = new FakeNativeLvgl();
  const id = lvgl.create("view");
  const previous = normalizeStyle({ gap: 4 });
  const next = normalizeStyle({});
  applyStyleDiff(lvgl, id, previous, next);
  assert.deepEqual(lvgl.resetStyleCalls, [
    { id, prop: P.gap },
    { id, prop: P.flexDirection },
  ]);
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
