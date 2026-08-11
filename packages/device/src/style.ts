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
 *   (LVGL translate, not position).
 * - `display` (14): "none" is 1 (hidden), "flex" is 0 (shown).
 * - `flexDirection` (15): row=0, column=1, row-reverse=2, column-reverse=3.
 * - `justifyContent` (16): flex-start=0, flex-end=1, center=2,
 *   space-between=3, space-around=4, space-evenly=5.
 * - `alignItems` (17): flex-start=0, flex-end=1, center=2 (no "stretch").
 * - `gap` (18): finite number >= 0, rounded; negative/non-finite skip.
 * - `flexGrow` (19): finite number, rounded, clamped 0..255 (LVGL
 *   `flex_grow` is `uint8_t` — 256 would wrap to 0); negative skips. `flex`
 *   (core alias) normalizes into this same code, no separate code.
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

function normalizeColor(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "transparent") return undefined;
  const named = NAMED_COLORS[value];
  if (named !== undefined) return named;
  if (!HEX_COLOR_RE.test(value)) return undefined;
  return parseInt(value.slice(1), 16);
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded < 0 ? undefined : rounded;
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
    return Math.round(value);
  }
  if (typeof value !== "string") return undefined;
  if (value === "auto") return -2000;
  if (!value.endsWith("%")) return undefined;
  const percent = Number.parseFloat(value.slice(0, -1));
  if (!Number.isFinite(percent)) return undefined;
  const clamped = Math.min(1000, Math.max(0, Math.round(percent)));
  return -(clamped + 1);
}

/** left/top: any finite number, rounded; negatives are valid (LVGL translate). */
function normalizeTranslate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.round(value);
}

function normalizeDisplay(value: unknown): number | undefined {
  if (value === "none") return 1;
  if (value === "flex") return 0;
  return undefined;
}

type StyleNormalizer = (value: unknown, out: Map<number, number>) => void;

function colorProp(prop: number): StyleNormalizer {
  return (value, out) => {
    const color = normalizeColor(value);
    if (color !== undefined) out.set(prop, color);
  };
}

function intProp(prop: number): StyleNormalizer {
  return (value, out) => {
    const int = normalizeNonNegativeInt(value);
    if (int !== undefined) out.set(prop, int);
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

function textAlignProp(value: unknown, out: Map<number, number>): void {
  const code = normalizeTextAlign(value);
  if (code !== undefined) out.set(NATIVE_STYLE_PROP.textAlign, code);
}

function dimProp(prop: number): StyleNormalizer {
  return (value, out) => {
    const dim = normalizeDimension(value);
    if (dim !== undefined) out.set(prop, dim);
  };
}

function translateProp(prop: number): StyleNormalizer {
  return (value, out) => {
    const translate = normalizeTranslate(value);
    if (translate !== undefined) out.set(prop, translate);
  };
}

function displayProp(value: unknown, out: Map<number, number>): void {
  const code = normalizeDisplay(value);
  if (code !== undefined) out.set(NATIVE_STYLE_PROP.display, code);
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

function enumProp(prop: number, values: Readonly<Record<string, number>>): StyleNormalizer {
  return (value, out) => {
    if (typeof value !== "string") return;
    const code = values[value];
    if (code !== undefined) out.set(prop, code);
  };
}

/** flexGrow/flex: finite number, rounded, clamped 0..255 (LVGL flex_grow is uint8); negative skips. */
function flexGrowProp(prop: number): StyleNormalizer {
  return (value, out) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const rounded = Math.round(value);
    if (rounded < 0) return;
    out.set(prop, Math.min(255, rounded));
  };
}

const P = NATIVE_STYLE_PROP;

/**
 * One normalizer per `TextStyle` key. Typed as `Record<keyof TextStyle, ...>`
 * so a key added to core's `TextStyle` without a matching normalizer here
 * fails the device build (exhaustiveness, mirrors `widgetKindByType` in
 * lvgl-host.ts).
 */
const STYLE_NORMALIZERS: Readonly<Record<keyof TextStyle, StyleNormalizer>> = Object.freeze({
  padding: paddingSides(P.paddingTop, P.paddingRight, P.paddingBottom, P.paddingLeft),
  paddingHorizontal: paddingSides(P.paddingRight, P.paddingLeft),
  paddingVertical: paddingSides(P.paddingTop, P.paddingBottom),
  paddingTop: intProp(P.paddingTop),
  paddingRight: intProp(P.paddingRight),
  paddingBottom: intProp(P.paddingBottom),
  paddingLeft: intProp(P.paddingLeft),
  backgroundColor: colorProp(P.backgroundColor),
  borderColor: colorProp(P.borderColor),
  borderWidth: intProp(P.borderWidth),
  borderRadius: intProp(P.borderRadius),
  color: colorProp(P.color),
  textAlign: textAlignProp,
  width: dimProp(P.width),
  height: dimProp(P.height),
  position: positionProp,
  left: translateProp(P.left),
  top: translateProp(P.top),
  display: displayProp,
  flexDirection: enumProp(P.flexDirection, FLEX_DIRECTION_VALUES),
  justifyContent: enumProp(P.justifyContent, JUSTIFY_CONTENT_VALUES),
  alignItems: enumProp(P.alignItems, ALIGN_ITEMS_VALUES),
  gap: intProp(P.gap),
  flexGrow: flexGrowProp(P.flexGrow),
  flex: flexGrowProp(P.flexGrow),
});

/**
 * Fixed processing order for deterministic native-call order. Padding
 * shorthands come first so a more specific key (e.g. `paddingTop`) always
 * overwrites the shorthand's fan-out via `Map.set`, per RN precedence.
 */
const STYLE_KEY_ORDER: readonly (keyof TextStyle)[] = [
  "padding",
  "paddingHorizontal",
  "paddingVertical",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "backgroundColor",
  "borderColor",
  "borderWidth",
  "borderRadius",
  "color",
  "textAlign",
  "width",
  "height",
  "position",
  "left",
  "top",
  "display",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  "flex",
  "flexGrow",
];

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
