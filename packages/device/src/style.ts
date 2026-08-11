/**
 * Normalizes the S1 `ViewStyle`/`TextStyle` surface (packages/core/src/index.ts)
 * into native style-prop codes and diffs two normalized styles into the
 * minimal `setStyle`/`resetStyle` native calls. Invalid values are skipped
 * silently: TS types catch style mistakes statically, so render must never
 * throw over a bad style value at runtime.
 */
import type { TextStyle } from "@tsx-lvgl/core";
import type { NativeLvgl } from "./native.js";

/** Mirrors `lvgl_host_style_prop_t` in lvgl_host.h. Append-only; never renumber. */
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
