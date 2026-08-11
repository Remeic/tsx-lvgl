# Feature 0011 — Widget styling

Status: S1 (box styles) implemented.

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

Planned, not yet implemented:

- S2: `width, height, minWidth/maxWidth, minHeight/maxHeight, top/right/bottom/left, position`.
- S3: `flexDirection, justifyContent, alignItems, alignSelf, flexGrow/flexShrink/flexBasis, gap`.
- S4: `opacity, transform: [{ rotate }, { scale }]`.

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
