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
| Derived Text expressions, e.g. `text={count * 2 + 1}` | Supported; lowered to saturating int32 arithmetic (`+ - * / %`), recomputed on state change. `/` and `%` are guarded (divide-by-zero yields 0) |
| Static integer Text literals | Exact decimal rendering is preserved, including values outside int32; state remains int32-only |
| Compile-time string concatenation, e.g. `text={"#" + name}` | Supported; folded to one literal. Runtime string state stays unsupported |
| `setCount(1)` / `setCount(expr)` | Supported for signed 32-bit integer literals and derived int32 expressions |
| `setCount(previous => previous + 1)` / `- 1` / `* 2` / `/ 2` | Supported; native update is saturating (division guarded) |
| `onClick={handler}` and `onClick={() => ...}` | Supported when the handler is same-component and contains one supported state update |
| State-driven conditionals: `{cond && <X/>}`, `{cond ? <A/> : <B/>}` | Supported; both branches are built once and toggled by `LV_OBJ_FLAG_HIDDEN` from an int32 predicate. Constant predicates fold at compile time |
| Component props (literals and state): `<Item value={count} />` | Supported; resolved by inlining each instance. A state prop forwards the caller's slot; props are a single destructured object parameter |
| Static lists: `{[a, b, c].map(item => <X ... />)}` | Supported for inline array literals of int/string literals, unrolled to fixed children; items flow into props. Runtime-length lists are rejected |
| `View direction="row" | "column"` | Supported |
| `View align="start" | "center" | "end"` | Supported |
| `View gap={0}` | Supported for non-negative signed 32-bit integer literals |
| Effects, context, refs, suspense, async components/handlers | Rejected with a source-positioned diagnostic: they need a JavaScript runtime the fixed-tree native target does not include |
| Out-of-range setter or functional-update literals | Rejected; arithmetic overflow is saturated at runtime |
| Runtime string values, floats, time/random/env reads, arbitrary calls | Rejected or outside the source-entry contract |
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
safe on the device. Floating point, runtime strings, objects, arrays, arbitrary
calls, and runtime hook dispatch are outside the contract. Integer arithmetic
(`+ - * / %`) and comparisons over state are supported and lower to saturating
int32 operations; division and modulo are guarded against a zero divisor.

## Rejected semantics and diagnostics

Unsupported syntax is rejected at the AST node that introduced it. Diagnostics
include the absolute entry path, one-based line, and one-based column, for
example:

```text
entry.tsx:4:19: unknown identifier total in expression
```

The compiler rejects conditional hook calls, non-literal initial state, hook
reordering constructs, out-of-range or floating-point literals, unknown handlers
and identifiers, spread props, runtime-length lists, effects/context/refs/async,
and any construct that would make the object tree dynamic. Props, static lists,
and conditionals are resolved at build time, so component instance identity and
hook order stay statically knowable.

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

The legacy-core tracer bullet at `examples/esp-idf/tsx_lvgl_v1` is intentionally
separate from that React MVP target. It is the firmware image used by the
guarded `board:reload` workflow and includes the visible boot/reload diagnostic;
it is not the parity artifact for `examples/counter.tsx`.

The pinned mutation gate is `./tools/dev mutation`, which runs independent
legacy and MVP Stryker configurations. The legacy configuration preserves
origin/main's high/low/break 100/100/100 policy with concurrency 1; the MVP
configuration uses high/low/break 80/70/80 with concurrency 4. A retained
reference Node 24.19.0 run, kept as historical context rather than current
evidence, reported no timeouts and classified legacy as 321 instrumented (240
killed, 0 survived, 80 `CompileError`, 1 ignored; 100.00% effective) and the
MVP compiler+React slice as 1,190 instrumented (644 killed, 39 survived, 507
`CompileError`, 0 ignored; 94.29% effective). TypeScript checker timing can
change killed/`CompileError`/survivor classification between runs, so neither
counts nor scores are invariant and these prose values must not be treated as
the result for a later SHA. The MVP scope includes `packages/react/src/**/*.ts`;
reports are written to `reports/mutation/legacy/` and `reports/mutation/mvp/`,
so legacy mutants cannot dilute the MVP score. The JSON reports paired with
the CI artifact `mutation-report-${GITHUB_SHA}` are authoritative for the
exact reviewed SHA; match that artifact SHA to the checked-out commit. The
remaining survivors and their dispositions are documented in [the mutation strategy](feature-specs/0002-testing-and-mutation-strategy.md);
native-emitter and JSX-runtime correctness cases have no survivors. CI uploads
both report directories as `mutation-report-${GITHUB_SHA}`. The simulator
evidence is uploaded as `container-validation-${GITHUB_SHA}` with `commit.txt`,
before/after PPMs, and both generated `ui.c` files; the recorded commit must
equal the artifact SHA.

None of those software gates proves physical boot, SH8601 panel output,
FT3168 touch, flush timing, power sequencing, board revision, or recovery. The
V1 applications use the real BSP path. The current recovery manifest is
`CONDITIONAL PASS`, but it never authorizes a write by itself: the guarded
reload wrapper still requires a fresh same-session identity/security/eFuse
preflight and writes only the app partition. No flash, erase, eFuse operation,
or board mutation is part of this validation.
