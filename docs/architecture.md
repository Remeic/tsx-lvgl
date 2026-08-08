# Runtime-first architecture

Status: M1 tracer bullet accepted on 2026-08-06. QuickJS-NG is the first
measured engine candidate, not yet the final engine selection.

## Core decision

TSX-LVGL is a runtime product:

```text
TSX → JavaScript bundle → replaceable JS engine → immutable VNodes
    → runtime reconciler → host adapter → LVGL
```

The application bundle runs on the device and can be replaced without a
firmware reflash. Native C is limited to the ESP-IDF task/transport boundary,
LVGL host adapter, board drivers and typed sensor adapters. UI is not emitted
as generated C. Git history is the source rollback for this migration; the
guarded board recovery procedure and known-good artifacts remain operational
controls, not an alternate UI architecture.

Only the known-good generated-C firmware artifact remains as guarded recovery
custody until the replacement runtime passes its simulator, firmware, board
and recovery gates. The compiler/emitter product implementation is deleted;
the recovery artifact is not part of the runtime design and receives no new
product features.

## Deep modules and seams

### `@tsx-lvgl/sdk`

Owns the only application-facing interface: the supported TSX tags, hooks and
high-level motion hook, plus the `tsx-lvgl` CLI. The CLI owns project metadata,
artifact verification, TypeScript checks, deterministic bundle production and
the headless kernel check. It deliberately does not expose the internal
workspace graph. The SDK npm-pack artifact vendors the compiled internal
packages and TypeScript under its own distribution directory, so an app can
work from a copied local artifact without a registry or a framework checkout.

The package-source seam is the artifact reference in
`.tsx-lvgl/framework.lock.json`. The lock records package version, source Git
SHA, artifact SHA-256 and byte length. `sync` installs that exact artifact;
`update` is the explicit source-to-artifact operation and rejects a dirty source
checkout. The CLI delegates installation to the consumer's declared or
detected package manager (npm, pnpm, yarn or bun), so package-manager choice is
not part of the application source contract. `dev` and `build` only verify the
lock and never resolve a newer source. The package remains private,
so `npm pack` is a deliberate local distribution action and `npm publish` is
not part of the workflow.

### `@tsx-lvgl/core`

Owns the small TSX vocabulary and immutable VNode model. The widget vocabulary
is declared once — an `elementTypes` array and a `WidgetProps` map — and
`Screen`/`View`/`Text`/`Button` are exported string constants, so `<Text
text="x"/>` creates an element VNode directly with no wrapper component. JSX
creates element, component or fragment VNodes; it never invokes a function
component. `VNode` is a discriminated union on `kind`. Keys, component type
references, props and children are part of the VNode identity contract. Core
has no LVGL, ESP-IDF, filesystem or transport dependency.

### `@tsx-lvgl/runtime`

Owns component identity, keyed reconciliation, state/effect hooks, scheduler
handoff, event replacement, sensor subscription ownership, reload epochs and
transactional root replacement. It is split into deep modules: `host.ts`
(LVGL seam + scheduler + runtime context), `hooks.ts`, `fiber.ts` (reconciler),
`session.ts` (one reload epoch), `runtime.ts` (root-swap transaction) and
`bundle.ts` (bounded bundle validation plus the replaceable engine evaluator
seam). Its public host seam is intentionally small: create, ordered insert,
patch, remove, dispose and root replacement. The host implementation owns LVGL
thread affinity and native handle lifetime.

### `@tsx-lvgl/sensors`

Owns versioned schemas and samples, and the whole fencing policy through
`subscribeSensor()`. A sample carries schema version, unit at the schema,
status, sequence, timestamp and reload epoch. `SensorContext` exposes
`isCancelled()` rather than an `AbortSignal`, because QuickJS-NG ships the ES
core and not the web platform. The runtime accepts only validated, monotonic
samples for the active epoch; old callbacks are cancelled and ignored.

### Board and simulator composition roots

The simulator and ESP-IDF host select concrete scheduler, host and sensor
adapters. They must satisfy the same contracts. QuickJS-NG lifecycle, job
pumping, memory limits and serialized ownership are explicit host concerns;
LVGL mutation occurs only through the owner task or its documented lock.

Consumer applications are not composition roots. They import `@tsx-lvgl/sdk`
only; the SDK facade adapts the app bundle's public module specifiers to the
same device-kernel aliases. Core/runtime/sensors/bundler/device workspace
imports remain framework-internal implementation details.

## First vertical slice

The implemented tracer bullet is:

```text
component VNode → Runtime → Screen/Text/Button host instances
              → button event → state update
              → deterministic interval → typed sensor sample
              → reload epoch → root swap or rollback
```

Deterministic tests cover lazy VNodes, immutable inputs, keyed state
preservation, host patching, event/timer cleanup, sensor validation and stale
epoch rejection. The real QuickJS-NG/LVGL/touch probe remains a separate
physical feasibility artifact; it does not prove the reconciler or hot reload.

`Runtime.reloadBundle` validates staged bytes, checks the evaluator identity,
and only then asks the selected engine to produce the candidate VNode root.
This is the host-test seam; QuickJS-NG execution and LVGL binding ownership
remain board-host evidence.

## Reload contract

Bundles are staged into bounded storage and checked for protocol, engine,
board, generation, hash shape and byte length before evaluation. A candidate
root is built without replacing the active root. The host then performs one
root replacement, candidate effects are activated, and only after success are
the old epoch, timers, event handlers and sensor contexts disposed. Evaluation
or activation failure restores the previous root and keeps its epoch.

State migration is intentionally out of scope for M1: every committed bundle
starts a new epoch. Transport authentication, signature policy, byte hashing,
QuickJS module loading and persistent last-known-good storage remain M2/M3
work.

## Evidence gates

- TypeScript build and deterministic package tests are necessary M1 evidence.
- Real LVGL simulator tests, ESP-IDF/QEMU builds and QuickJS memory/timing
  measurements are separate gates.
- Physical board evidence must include display, touch, repeated reload and
  recovery observations; no simulator or firmware build can pass that gate.
- The transient FT3168/I2C warm-reset failure is still open; see
  [the diagnosis note](diagnostics/ft3168-i2c-reset.md) for status and required evidence.
- Guarded app-only flashing, operation logs, identity/eFuse checks and recovery
  custody remain unchanged in `docs/recovery.md` and the board tools.
