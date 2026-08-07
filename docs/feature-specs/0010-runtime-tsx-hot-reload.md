# Feature 0010 — Runtime TSX, typed sensors and hot reload

Status: M1 tracer bullet implemented on 2026-08-06. The board and transport
gates remain open.

## Objective

Author supported interfaces in TSX, bundle the application as JavaScript,
execute it in a device-owned runtime, expose typed board capabilities, and
replace the UI bundle without reflashing firmware. The supported product path
does not generate UI C. Git history is source rollback; guarded recovery
artifacts protect the physical board.

## Package graph

```text
core ← runtime ← board host / simulator
          ↑
       bundle producer
          ↑
       sensors
```

`core` owns immutable VNodes and JSX. `runtime` owns reconciliation, hooks,
host operations, scheduling and reload epochs. `sensors` owns versioned
schemas and samples. The board host chooses QuickJS-NG, LVGL and ESP-IDF
adapters behind these seams. No application package imports LVGL or raw FFI.
The bundle producer remains a future TSX/JavaScript build boundary, while the
runtime already exposes `reloadBundle`: it validates bounded staged bytes and
passes them to a replaceable `RuntimeEngine` before entering the VNode reload
transaction. The retired generated-C compiler is not part of this product
path.

## VNode contract

Every render produces an immutable VNode:

```ts
type VNode = Readonly<{
  kind: "element" | "component" | "fragment";
  type: string | Component | FragmentType;
  key: string | number | null;
  props: Readonly<Record<string, unknown>>;
  children: readonly VNode[];
}>;
```

JSX stores function components as `kind: "component"`; it never calls them.
The reconciler identifies a child by parent, type reference and key. A type or
key change remounts it. Keys are unique among siblings. VNodes and their
children are never mutated by the runtime.

## Runtime host seam

The host interface is the only UI/native seam:

```ts
createInstance(type, props)
insertChild(parent, child, index)
updateInstance(instance, type, previousProps, nextProps)
removeChild(parent, child)
dispose(instance)
replaceRoot(next, previous)
```

`replaceRoot` is the transaction point. A real LVGL adapter must execute all
operations on the LVGL owner task or under the board's documented lock, and
must replace event callbacks rather than accumulate them.

## Typed sensor contract

Sensors are selected through a schema, not a native pointer:

- schema: stable `id`, version, optional unit and runtime validator;
- sample: sensor id, schema version, monotonic sequence, sample timestamp,
  reload epoch, status and optional validated value/error;
- read: asynchronous and cancellable via `SensorContext.isCancelled()`, not an
  `AbortSignal` — QuickJS-NG ships the ES core, not the web platform;
- subscribe: `subscribeSensor()` owns the fencing policy, returns an
  idempotent disposer and receives an epoch context.

The runtime rejects wrong schema versions, invalid values, non-monotonic
sequences and samples from an inactive epoch. Reload aborts old contexts before
their callbacks can update application state or LVGL.

## Transactional reload

1. Stage bytes in bounded storage; do not execute from the transport buffer.
2. Validate format, protocol, engine, board, generation, hash shape and length.
3. Evaluate the candidate root without replacing the active root.
4. Replace the root once through the host seam.
5. Activate candidate effects; on failure, replace the old root back.
6. Commit the new epoch, then dispose old effects, timers, events and sensors.

M1 resets application state on a committed reload. State migration is a later
feature. Transport authentication/signatures, persistent last-known-good
storage and QuickJS module loading are separate gates.

## M1 tracer bullet

The deterministic host path proves the slice diagrammed in
[the runtime architecture](../architecture.md#first-vertical-slice).

`Runtime.reloadBundle` covers the bundle-to-engine seam with a fake evaluator;
the real QuickJS-NG adapter remains a board-host gate.

A physical runtime-port probe on the ESP32-S3 board (not committed in this
change) proves only QuickJS-NG, direct LVGL calls, timer delivery,
sensor-shaped data and touch callback feasibility on the target. It is not
reconciler or hot-reload evidence.

## Validation ladder

- M1: TypeScript build, fake-host contract tests, VNode/reconciler/sensor/
  reload tests.
- M2: real LVGL simulator and deterministic bundle watcher/transport.
- M3: ESP-IDF/QEMU runtime host, heap/timing/cleanup measurements.
- M4: guarded physical app-only runtime reload, 100-cycle soak, recovery and
  touch/display evidence.

Build, simulator, QEMU and probe logs cannot pass the physical-board gate.
The transient FT3168/I2C warm-reset failure is still open; see
[the diagnosis note](../diagnostics/ft3168-i2c-reset.md) for status and
required evidence before declaring M4 green.
