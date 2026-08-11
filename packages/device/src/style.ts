/**
 * Normalizes the S1 `ViewStyle`/`TextStyle` surface (packages/core/src/index.ts)
 * into native style-prop codes and diffs two normalized styles into the
 * minimal `setStyle`/`resetStyle` native calls. Invalid values are skipped
 * silently: TS types catch style mistakes statically, so render must never
 * throw over a bad style value at runtime.
 */
import type { TextStyle } from "@tsx-lvgl/core";
import type { NativeLvgl } from "./native.js";

/**
 * Mirrors `lvgl_host_style_prop_t` in lvgl_host.h. Append-only; never renumber.
 *
 * Value encoding is OUR stable ABI, never an LVGL bit encoding:
 * - `width`/`height` (10/11): px is `value >= 0` (rounded); percent is
 *   `-(N + 1)` for `N` in 0..1000 (so -1..-1001); `"auto"` is -2000. One code
 *   per LVGL prop across all three forms — a px<->% transition must diff as a
 *   single `setStyle`, never a `setStyle` + `resetStyle` pair on the same
 *   underlying LVGL prop (the trailing reset would wipe the new value).
 * - `left`/`top` (12/13): any finite number, rounded; negatives are valid
 *   (LVGL translate, not position); values outside signed int32 are skipped.
 * - `display` (14): "none" is 1 (hidden), "flex" is 0 (shown).
 * - `flexDirection` (15): row=0, column=1, row-reverse=2, column-reverse=3.
 * - `justifyContent` (16): flex-start=0, flex-end=1, center=2,
 *   space-between=3, space-around=4, space-evenly=5.
 * - `alignItems` (17): flex-start=0, flex-end=1, center=2 (no "stretch").
 * - `gap` (18): finite number >= 0, rounded; negative/non-finite/int32-overflow skip.
 * - `flexGrow` (19): finite number, rounded, clamped 0..255 (LVGL
 *   `flex_grow` is `uint8_t` — 256 would wrap to 0); negative skips. `flex`
 *   (core alias) normalizes into this same code, no separate code.
 * - `opacity` (20): finite number, clamped 0..1 (CSS-style clamp, not skip),
 *   then `Math.round(v * 255)` (LVGL `opa` 0..255); non-finite/non-number
 *   skips.
 * - `rotate` (21): degrees clockwise, `Math.round(deg * 10)` (LVGL
 *   deci-degrees); a number is taken as-is, a string must match
 *   `` `${number}deg` `` (the leading float is parsed, anything else is
 *   rejected); negatives are valid; non-finite skips.
 *   `LV_SCALE_NONE` = 100%); negative/non-finite/int32-overflow skips.
 */
export const NATIVE_STYLE_PROP = Object.freeze({
  backgroundColor: 0,
  borderColor: 1,
  borderWidth: 2,
  borderRadius: 3,
  paddingTop: 4,
  paddingRight: 5,
  paddingBottom: 6,
  paddingLeft: 7,
  color: 8,
  textAlign: 9,
  width: 10,
  height: 11,
  left: 12,
  top: 13,
  display: 14,
  flexDirection: 15,
  justifyContent: 16,
  alignItems: 17,
  gap: 18,
  flexGrow: 19,
  opacity: 20,
  rotate: 21,
  scale: 22,
} as const);

export type NormalizedStyle = ReadonlyMap<number, number>;

const NAMED_COLORS: Readonly<Record<string, number>> = Object.freeze({
  red: 0xff0000,
  green: 0x008000,
  blue: 0x0000ff,
  black: 0x000000,
  white: 0xffffff,
  gray: 0x808080,
  yellow: 0xffff00,
  cyan: 0x00ffff,
  magenta: 0xff00ff,
});

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PERCENT_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?%$/;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

function normalizeColor(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "transparent") return undefined;
  const named = NAMED_COLORS[value];
  if (named !== undefined) return named;
  if (!HEX_COLOR_RE.test(value)) return undefined;
  return parseInt(value.slice(1), 16);
}

/** Rounds a finite number only when its encoded value fits the signed-int32 ABI. */
function normalizeInt32(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded < INT32_MIN || rounded > INT32_MAX ? undefined : rounded;
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return normalizeInt32(value);
}

function normalizeTextAlign(value: unknown): number | undefined {
  if (value === "left") return 0;
  if (value === "center") return 1;
  if (value === "right") return 2;
  return undefined;
}

/** width/height: px (>=0, rounded) | "N%" (rounded, clamped 0..1000, -(N+1)) | "auto" (-2000). */
function normalizeDimension(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return normalizeInt32(value);
  }
  if (typeof value !== "string") return undefined;
  if (value === "auto") return -2000;
  if (!PERCENT_RE.test(value)) return undefined;
  const percent = Number(value.slice(0, -1));
  if (!Number.isFinite(percent)) return undefined;
  const clamped = Math.min(1000, Math.max(0, Math.round(percent)));
  return -(clamped + 1);
}

/** left/top: any finite number, rounded; negatives are valid (LVGL translate). */
function normalizeTranslate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return normalizeInt32(value);
}

function normalizeDisplay(value: unknown): number | undefined {
  if (value === "none") return 1;
  if (value === "flex") return 0;
  return undefined;
}

type StyleNormalizer = (value: unknown, out: Map<number, number>) => void;

/** Every single-code key shares this shape: validate, then `Map.set`. */
function setProp(prop: number, normalize: (value: unknown) => number | undefined): StyleNormalizer {
  return (value, out) => {
    const normalized = normalize(value);
    if (normalized !== undefined) out.set(prop, normalized);
  };
}

/** Padding shorthand: one valid value fans out to every listed per-side code. */
function paddingSides(...props: readonly number[]): StyleNormalizer {
  return (value, out) => {
    const int = normalizeNonNegativeInt(value);
    if (int === undefined) return;
    for (const prop of props) out.set(prop, int);
  };
}

/** v1: absolute and relative are equivalent; no native effect. */
function positionProp(): void {}

const FLEX_DIRECTION_VALUES: Readonly<Record<string, number>> = Object.freeze({
  row: 0,
  column: 1,
  "row-reverse": 2,
  "column-reverse": 3,
});

const JUSTIFY_CONTENT_VALUES: Readonly<Record<string, number>> = Object.freeze({
  "flex-start": 0,
  "flex-end": 1,
  center: 2,
  "space-between": 3,
  "space-around": 4,
  "space-evenly": 5,
});

const ALIGN_ITEMS_VALUES: Readonly<Record<string, number>> = Object.freeze({
  "flex-start": 0,
  "flex-end": 1,
  center: 2,
});

function enumOf(values: Readonly<Record<string, number>>): (value: unknown) => number | undefined {
  return (value) => (typeof value === "string" ? values[value] : undefined);
}

/** flexGrow/flex: finite number, rounded, clamped 0..255 (LVGL flex_grow is uint8); negative skips. */
function normalizeFlexGrow(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const rounded = Math.round(value);
  return Math.min(255, rounded);
}

/** opacity: finite number, clamped 0..1 (CSS clamp, not skip) then scaled to LVGL opa 0..255. */
function normalizeOpacity(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 255);
}

const ROTATE_DEG_RE = /^(-?\d+(?:\.\d+)?)deg$/;

/** rotate: number is degrees as-is; string must be exactly `${number}deg`; both scale to LVGL deci-degrees. */
function normalizeRotate(value: unknown): number | undefined {
  let degrees: number;
  if (typeof value === "number") {
    degrees = value;
  } else if (typeof value === "string") {
    const match = ROTATE_DEG_RE.exec(value);
    const captured = match?.[1];
    if (captured === undefined) return undefined;
    degrees = Number.parseFloat(captured);
  } else {
    return undefined;
  }
  return Number.isFinite(degrees) ? normalizeInt32(degrees * 10) : undefined;
}

/** scale: finite number >= 0, scaled to LVGL's 256 == LV_SCALE_NONE == 100%; negative/non-finite skip. */
function normalizeScale(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return normalizeInt32(value * 256);
}

const P = NATIVE_STYLE_PROP;

/**
 * One normalizer per `TextStyle` key. Typed as `Record<keyof TextStyle, ...>`
 * so a key added to core's `TextStyle` without a matching normalizer here
 * fails the device build (exhaustiveness, mirrors `widgetKindByType` in
 * lvgl-host.ts).
 *
 * Declaration order IS the processing order (`STYLE_KEY_ORDER` derives from
 * it): padding shorthands before per-side keys and `flex` before `flexGrow`,
 * so the more specific key always overwrites via `Map.set` (RN precedence).
 */
const STYLE_NORMALIZERS: Readonly<Record<keyof TextStyle, StyleNormalizer>> = Object.freeze({
  padding: paddingSides(P.paddingTop, P.paddingRight, P.paddingBottom, P.paddingLeft),
  paddingHorizontal: paddingSides(P.paddingRight, P.paddingLeft),
  paddingVertical: paddingSides(P.paddingTop, P.paddingBottom),
  paddingTop: setProp(P.paddingTop, normalizeNonNegativeInt),
  paddingRight: setProp(P.paddingRight, normalizeNonNegativeInt),
  paddingBottom: setProp(P.paddingBottom, normalizeNonNegativeInt),
  paddingLeft: setProp(P.paddingLeft, normalizeNonNegativeInt),
  backgroundColor: setProp(P.backgroundColor, normalizeColor),
  borderColor: setProp(P.borderColor, normalizeColor),
  borderWidth: setProp(P.borderWidth, normalizeNonNegativeInt),
  borderRadius: setProp(P.borderRadius, normalizeNonNegativeInt),
  color: setProp(P.color, normalizeColor),
  textAlign: setProp(P.textAlign, normalizeTextAlign),
  width: setProp(P.width, normalizeDimension),
  height: setProp(P.height, normalizeDimension),
  position: positionProp,
  left: setProp(P.left, normalizeTranslate),
  top: setProp(P.top, normalizeTranslate),
  display: setProp(P.display, normalizeDisplay),
  flexDirection: setProp(P.flexDirection, enumOf(FLEX_DIRECTION_VALUES)),
  justifyContent: setProp(P.justifyContent, enumOf(JUSTIFY_CONTENT_VALUES)),
  alignItems: setProp(P.alignItems, enumOf(ALIGN_ITEMS_VALUES)),
  gap: setProp(P.gap, normalizeNonNegativeInt),
  flex: setProp(P.flexGrow, normalizeFlexGrow),
  flexGrow: setProp(P.flexGrow, normalizeFlexGrow),
  opacity: setProp(P.opacity, normalizeOpacity),
  rotate: setProp(P.rotate, normalizeRotate),
  scale: setProp(P.scale, normalizeScale),
});

/** Deterministic native-call order = declaration order of the table above. */
const STYLE_KEY_ORDER = Object.keys(STYLE_NORMALIZERS) as readonly (keyof TextStyle)[];

/** Later array entries win at the key level; falsy entries are skipped. */
function mergeStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    const merged: Record<string, unknown> = {};
    for (const entry of style) {
      if (!entry) continue;
      Object.assign(merged, entry);
    }
    return merged;
  }
  return (style ?? {}) as Record<string, unknown>;
}

export function normalizeStyle(style: unknown): NormalizedStyle {
  const merged = mergeStyle(style);
  const out = new Map<number, number>();
  for (const key of STYLE_KEY_ORDER) STYLE_NORMALIZERS[key](merged[key], out);
  // Implied flex: justifyContent/alignItems/gap only matter on a flex
  // container, so setting any of them without an explicit flexDirection
  // implies "column" (RN default) instead of silently no-opping.
  if (!out.has(P.flexDirection) && (out.has(P.justifyContent) || out.has(P.alignItems) || out.has(P.gap))) {
    out.set(P.flexDirection, 1);
  }
  return out;
}

export function applyStyleDiff(native: NativeLvgl, id: number, previous: NormalizedStyle, next: NormalizedStyle): void {
  // Deliberately no `previous === next` fast path: normalizeStyle always
  // allocates a fresh Map, so the two are never the same instance and the
  // check would be permanently-false dead code — an unkillable mutant.
  for (const [prop, value] of next) {
    if (previous.get(prop) !== value) native.setStyle(id, prop, value);
  }
  for (const prop of previous.keys()) {
    if (!next.has(prop)) native.resetStyle(id, prop);
  }
}
