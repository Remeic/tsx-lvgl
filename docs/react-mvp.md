# React-ergonomic TSX MVP

The `@tsx-lvgl/react` package is a compatibility-shaped authoring surface, not
React itself. A source entry is analyzed at build time and lowered to a fixed
LVGL 9.5.0 object tree plus native C callbacks. No React package, Fiber tree,
reconciler, JavaScript engine, dynamic loader, or component evaluator is put on
the ESP32.

## Compatibility table

| Authoring form | MVP result |
| --- | --- |
| `Screen`, `View`, `Text`, `Button` | Supported |
| `<>...</>` and `Fragment` | Supported; transparent native group |
| Zero-argument local function components | Supported; each JSX instance gets independent native state slots |
| `useState(0)`-style hooks | Supported only with signed 32-bit integer literals and fixed top-level hook order |
| `Text text={count}` or `<Text>{count}</Text>` | Supported for a direct state identifier |
| Static integer Text literals | Exact decimal rendering is preserved, including values outside int32; state remains int32-only |
| `setCount(1)` | Supported for signed 32-bit integer literals |
| `setCount(previous => previous + 1)` | Supported; native update is saturating |
| `setCount(previous => previous - 1)` | Supported; native update is saturating |
| `onClick={handler}` and `onClick={() => ...}` | Supported when the handler is same-component and contains one supported state update |
| `View direction="row" | "column"` | Supported |
| `View align="start" | "center" | "end"` | Supported |
| `View gap={0}` | Supported for non-negative signed 32-bit integer literals |
| Component props, effects, context, refs, suspense, lists, conditional trees | Rejected with a source-positioned diagnostic |
| Out-of-range setter or functional-update literals | Rejected; arithmetic overflow is saturated at runtime |
| Arbitrary expressions, derived Text values, async code, time/random/env reads | Rejected or outside the source-entry contract |
| Physical display/touch/power behavior | Not proven by this MVP |

The source compiler API is:

```ts
compileProject({ entryFile: "examples/counter.tsx", projectName: "counter" });
```

The entry must have a default-exported zero-argument function component whose
root is `<Screen>`. The compiler parses the TypeScript/TSX AST and creates an
opaque internal native program. The LVGL emitter is the only layer that knows
LVGL names; simulator and ESP-IDF applications consume the emitted `ui.c`.

## Why integer-only state

The first state primitive is intentionally a signed 32-bit integer because it
has a small, auditable representation on ESP32, no garbage collection or
allocation requirement, stable formatting storage, and deterministic overflow
behavior. Every functional update is lowered to a native `int64_t` intermediate
and clamps to `[-2147483648, 2147483647]`. Repeated events update existing
objects and static label buffers; the generated callback never rebuilds the
tree.

This is a compiler contract, not a claim that JavaScript numbers are generally
safe on the device. Floating point, strings, objects, arrays, arbitrary setter
expressions, and runtime hook dispatch are outside the contract.

## Rejected semantics and diagnostics

Unsupported syntax is rejected at the AST node that introduced it. Diagnostics
include the absolute entry path, one-based line, and one-based column, for
example:

```text
entry.tsx:4:19: Text bindings must be a direct state identifier or literal
```

The compiler rejects conditional hook calls, non-literal initial state, hook
reordering constructs, unsupported arithmetic, unknown handlers, spread props,
component props, dynamic children, and non-fixed trees. This keeps component
instance identity and hook order statically knowable.

## Evidence boundary

`npm test` and `npm run test:c` prove TypeScript/compiler behavior and warnings-as
errors syntax compilation against the checked-in stub. `npm run simulator:test`
builds the exact generated C against a SHA-256-verified LVGL v9.5.0 archive,
injects SDL mouse events through the LVGL SDL pointer driver and hit-test, checks
the label and framebuffer change `0 -> 1`, and writes before/after screenshots.
The ESP-IDF V1 target builds the same entry artifact through the pinned
Waveshare BSP `1.1.4` with ESP-IDF 5.5.5 and reports firmware size. The
`generated:parity` check compares the source output with the simulator and
ESP-IDF `ui.c` byte-for-byte.

The pinned mutation gate is `./tools/dev mutation`, which runs independent
legacy and MVP Stryker configurations, each with break threshold 80. The final
exact Node 24.19.0 run had no timeouts: legacy instrumented 300 mutants (222
killed, 0 survived, 77 compile errors, 1 ignored; 100.00% effective), while
the MVP compiler+React slice instrumented 1,190 (648 killed, 40 survived, 502
compile errors, 0 ignored; 94.19% effective, `648 / (648 + 40)`). The MVP
scope includes `packages/react/src/**/*.ts`; reports are written to
`reports/mutation/legacy/` and `reports/mutation/mvp/`, so legacy mutants cannot
dilute the MVP score. The remaining survivors and their dispositions are
documented in [the mutation strategy](feature-specs/0002-testing-and-mutation-strategy.md);
native-emitter and JSX-runtime correctness cases have no survivors. CI uploads
both report directories as `mutation-report-${GITHUB_SHA}`. The simulator
evidence is uploaded as `container-validation-${GITHUB_SHA}` with `commit.txt`,
before/after PPMs, and both generated `ui.c` files; the recorded commit must
equal the artifact SHA.

None of those software gates proves physical boot, SH8601 panel output,
FT3168 touch, flush timing, power sequencing, board revision, or recovery. The
V1 application uses the real BSP path, but `docs/recovery.md` remains
`HARD STOP — FACTORY RECOVERY NOT PROVEN`. No flash, erase, eFuse operation, or
board mutation is part of this MVP.
