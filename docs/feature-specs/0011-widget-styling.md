# Feature 0011 — Widget styling

Status: S1 (box styles), S2 (size/position/display), S3 (flex layout), S4
(opacity/rotate/scale) implemented.

## Objective

A React-Native-shaped `style` prop on every widget, normalized on-device into
per-key native calls. No LVGL style objects or C generation cross the JS/TS
boundary; only pre-normalized ints do.

## API shape

```ts
style?: StyleProp<ViewStyle>   // Screen, View
style?: StyleProp<TextStyle>   // Text, Button (TextStyle extends ViewStyle)
type StyleProp<T> = T | ReadonlyArray<T | false | null | undefined>;
```

`StyleSheet.create(styles)` freezes the sheet and every entry (RN-shaped, no
lookup indirection — the returned objects are the same style objects).

## S1 key set

`backgroundColor, borderColor, borderWidth, borderRadius, padding,
paddingTop, paddingRight, paddingBottom, paddingLeft, paddingHorizontal,
paddingVertical, color, textAlign`.

## S2 key set

`width, height, position, left, top, display`, on `ViewStyle` (so `TextStyle`
too). `ScreenStyle` (Screen's `style` prop type) excludes `width, height,
position, left, top, display` — a screen has no parent to size/position/hide
itself against — via `Omit<ViewStyle, ...>`.

- `width`/`height`: `number | \`${number}%\` | "auto"` (`StyleDim`, exported
  from core). px is `value >= 0`, rounded; negative px is invalid and skips
  the key. `"N%"` is `N` parsed as a float, rounded, clamped to 0..1000, then
  value-encoded (see ABI below). `"auto"` sizes to content. Anything else
  (bad string, non-number/string) skips the key.
- `position?: "absolute" | "relative"`: accepted for RN-shape compat, but v1
  gives both **no native effect** — LVGL absolute-like semantics are the
  default already, so the key is a documented equivalent, not yet wired.
- `left`/`top`: any finite `number`, rounded; negative is valid. Maps to
  LVGL translate (not a position offset), so it composes with future flex
  parents (S3) instead of fighting layout.
- `display?: "flex" | "none"`: `"none"` hides the widget (LVGL
  `LV_OBJ_FLAG_HIDDEN`) without unmounting it — state and children are
  preserved, `"flex"` (or removing the key) shows it again. `"flex"` is not
  itself a layout mode yet (that's S3); it is just "shown".

## S3 key set

`flexDirection, justifyContent, alignItems, gap, flexGrow, flex`, on
`ViewStyle` (so `TextStyle` and `ScreenStyle` too — `ScreenStyle`'s `Omit`
only drops the S2 size/position/display keys, not the S3 flex-container
keys, so a `Screen` can itself be a flex container).

- `flexDirection?: "row" | "column" | "row-reverse" | "column-reverse"`:
  row=0, column=1, row-reverse=2, column-reverse=3.
- `justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" |
  "space-around" | "space-evenly"`: 0-5 in that order.
- `alignItems?: "flex-start" | "flex-end" | "center"`: 0-2 in that order. No
  `"stretch"` — LVGL flex has none; the idiom is a child `height: "100%"`.
- `gap?: number`: px, applied to both row and column gap. Finite number >= 0,
  rounded; negative/non-finite skips.
- `flexGrow?: number`: 0..255 (LVGL `flex_grow` is `uint8_t` — 256 would wrap
  to 0). Finite number, rounded, clamped to 0..255; negative skips.
- `flex?: number`: RN shorthand, alias of `flexGrow` — normalizes into the
  same native code. An explicit `flexGrow` wins if both are present (fixed
  key order processes `flex` before `flexGrow`, and `Map.set` is
  last-write-wins).

**Implied flex.** Setting `justifyContent`, `alignItems` or `gap` without an
explicit `flexDirection` implies `flexDirection: "column"` (RN's default) —
otherwise those keys would silently no-op on a non-flex container. `flexGrow`
and `flex` do **not** trigger this: they're a child's own property, not a
container setting. Removing the last trigger key on re-render naturally diffs
away the implied `flexDirection` too (`resetStyle`), since `normalizeStyle`
recomputes it from scratch every render.

## S4 key set

`opacity, rotate, scale`, on `ViewStyle` (so `TextStyle` and `ScreenStyle`
too — flat keys, not an RN `transform: [...]` array).

- `opacity?: number`: 0..1, clamped (CSS behavior — out-of-range finite
  values clamp, they do not skip the key). Scales to plain LVGL `opa`
  (`Math.round(v * 255)`), a **per-draw-op** blend, not CSS group opacity.
  `opa_layered` was considered and rejected: it forces a full-area layer
  buffer (hundreds of KB fullscreen, no chunking, matrix path off by
  default). Consequence: overlapping children of a semi-transparent parent
  may double-blend where they overlap, unlike CSS group opacity. Non-finite
  or non-number values skip the key.
- `rotate?: number | \`${number}deg\``: degrees clockwise, center pivot. A
  number is degrees as-is; a string must match `` `${number}deg` `` exactly
  (the leading float is parsed, anything else — missing suffix, trailing
  garbage — skips the key). Scales to LVGL deci-degrees
  (`Math.round(deg * 10)`); negative values are valid. Non-finite skips.
- `scale?: number`: 1 = 100%, center pivot. Finite number >= 0, scaled to
  LVGL's `Math.round(v * 256)` (256 = `LV_SCALE_NONE` = 100%);
  negative/non-finite skips.

**Pivot.** LVGL's default transform pivot is top-left; CSS's
`transform-origin` default is center. `rotate`/`scale`'s native setter
therefore always forces the pivot to center (`lv_pct(50)` on both axes) as a
side effect. Because `rotate` and `scale` share the same pivot props and the
C host is stateless, `resetStyle` for either one leaves the pivot props in
place — it cannot know whether the other transform is still active. A
leftover pivot with no active transform is inert by design (no transform, no
visible effect), so this is safe to leave rather than track.

**Hardware validation (open item).** `rotate`/`scale` force a full-area LVGL
transform layer, same cost profile as layered opacity. Benchmark on hardware
before relying on animated transforms in a real app — this slice does not
include that measurement.

## Normalization (`packages/device/src/style.ts`)

- Array styles flatten RN-style: falsy entries skip, later objects win at the
  key level, merged *before* normalization.
- Colors: `#rrggbb` (6 hex digits, case-insensitive) or a fixed named set
  (red/green/blue/black/white/gray/yellow/cyan/magenta). `"transparent"`
  skips the key — with the S0 neutral baseline, absent means transparent.
  Anything else invalid (bad hex, unknown name, non-string) skips the key.
- Numbers (borderWidth, borderRadius, paddings): must be `Number.isFinite`,
  then `Math.round`; negative skips. NaN/Infinity skip.
- `textAlign`: left=0, center=1, right=2; anything else skips.
- Unknown object keys are ignored (forward-compat with later slices).
- **Invalid is always skip-silent, never throw.** TS types are the contract;
  render must survive a malformed style at runtime.
- Padding precedence (fixed processing order, `Map.set` last-write-wins):
  `padding` < `paddingHorizontal`/`paddingVertical` < the four per-side keys.
  There is no native "all sides" code — the shorthand fans out to the 4
  per-side codes (4-7) on the C side; only per-side values ever cross the ABI.
- `normalizeStyle` output is a `ReadonlyMap<code, value>`, immutable by
  contract (never mutated after being handed to `applyStyleDiff`/stored on
  a `DeviceInstance`).

## ABI (`packages/device/src/native.ts`, mirrored by `lvgl_host.h`)

```ts
setStyle(id: number, prop: number, value: number): void;
resetStyle(id: number, prop: number): void;
```

`prop` is a `NATIVE_STYLE_PROP` code — append-only, never renumbered. A
committed test (`tests/runtime-probe-source.test.mjs`) regex-extracts
`lvgl_host_style_prop_t` from the C header and asserts it deep-equals
`NATIVE_STYLE_PROP`; the two can never drift silently.

S2 value encoding is our own stable ABI, never an LVGL bit encoding — mirrored
in both `packages/device/src/style.ts` and `lvgl_host.h`:

- `width`/`height` (codes 10/11): one code per LVGL prop across px, percent
  and auto, so a px<->% transition diffs as a single `setStyle` — two codes
  would emit a `setStyle` + `resetStyle` pair touching the same LVGL prop,
  and the trailing reset would wipe the new value. `value >= 0` is px
  (`lv_obj_set_style_width/height`); `value == -2000` is `"auto"`
  (`LV_SIZE_CONTENT`); `-1001 <= value <= -1` is percent `N`, recovered as
  `lv_pct(-(value) - 1)`.
- `left`/`top` (codes 12/13): any int32, applied via
  `lv_obj_set_style_translate_x/y`.
- `display` (code 14): 1 sets `LV_OBJ_FLAG_HIDDEN`, 0 (or reset) clears it —
  a widget flag, not an `LV_STYLE_*` prop, so `resetStyle` for this code
  clears the flag instead of calling `lv_obj_remove_local_style_prop`.
- `position` has no code at all: its normalizer is registered (so
  `STYLE_NORMALIZERS` stays an exhaustive `Record<keyof TextStyle, ...>`)
  but intentionally emits nothing.
- `flexDirection`/`justifyContent`/`alignItems` (codes 15-17): enum ints, see
  S3 key set above. `gap` (code 18): non-negative int32, fans out on the C
  side to both `pad_row` and `pad_column`. `flexGrow` (code 19): 0..255;
  `flex` has no code of its own — it normalizes into 19.
- All S3 set/reset cases in `lvgl_host.c` are compiled under `#if
  LV_USE_FLEX` / `#endif`: a consumer building with `LV_USE_FLEX` off would
  otherwise fail to compile against the flex setter APIs. With it off, codes
  15-19 fall through to the `default` no-op on both `setStyle` and
  `resetStyle` (same defensive-ignore path as an unknown code).
- Two S3 codes are composite on reset, same pattern as `backgroundColor`:
  - `flexDirection`: `lv_obj_set_flex_flow` sets both `LV_STYLE_FLEX_FLOW`
    and `LV_STYLE_LAYOUT` on the way in, so its reset removes both.
  - `gap`: sets both `pad_row` and `pad_column` on the way in, so its reset
    removes both `LV_STYLE_PAD_ROW` and `LV_STYLE_PAD_COLUMN`.
- `opacity` (code 20): 0..255 LVGL `opa`, defensively re-clamped on the C
  side too; `lv_obj_set_style_opa`, reset removes `LV_STYLE_OPA`.
- `rotate` (code 21): deci-degrees, `lv_obj_set_style_transform_rotation`;
  reset removes only `LV_STYLE_TRANSFORM_ROTATION`, deliberately leaving the
  pivot props set (see Pivot above). Not gated behind `#if LV_USE_FLEX` —
  LVGL transforms are core, not a flex feature.
- `scale` (code 22): `lv_obj_set_style_transform_scale_x`/`_y`, both set to
  the same value (256 = 100%); reset removes both
  `LV_STYLE_TRANSFORM_SCALE_X` and `LV_STYLE_TRANSFORM_SCALE_Y`, same pivot
  rationale as `rotate`.

Button routing: `color`/`textAlign` (codes 8-9) target the button's inner
label; every other code targets the widget's own object. Resetting
`backgroundColor` is composite on the C side — it removes both
`LV_STYLE_BG_COLOR` and `LV_STYLE_BG_OPA`, since `setStyle` for
`backgroundColor` always sets both together (opacity forces the color
visible).

## Diff semantics (`applyStyleDiff`)

Given `previous`/`next` normalized maps: `setStyle` fires only for a `next`
entry whose value differs from `previous.get(prop)`; `resetStyle` fires for
every `previous` key absent from `next`. No `previous === next` identity
fast path — `normalizeStyle` always allocates a fresh `Map`, so the two
instances are never equal and the check would be dead code.

This diff is what makes the style prop practical: the reconciler's shallow
`sameProps` check treats a new style object literal as changed on every
render (object identity, not content), so `updateInstance` runs every time a
styled node re-renders. The per-key diff absorbs that churn — a fresh
object with identical content re-normalizes to an equal-valued map and emits
zero native calls.

`createInstance` applies styles for all four widget types (`Screen`, `View`,
`Text`, `Button`) against an empty baseline. `updateInstance` diffs style
first, before any type-specific logic — Screen/View, which previously had no
`updateInstance` body at all, now do.
