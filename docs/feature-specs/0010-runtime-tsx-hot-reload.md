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

## Consumer package boundary

Applications use `@tsx-lvgl/sdk` and the `tsx-lvgl` CLI. The facade owns the
public tags, hooks and high-level sensor helper; applications do not import
the internal package graph. A framework checkout produces a standard npm-pack
tarball whose `dist/vendor` directory contains the compiled core, sensors,
runtime, bundler, device adapter and TypeScript compiler needed by the CLI.
The artifact is copied into the application and referenced by a relative
`.tsx-lvgl/artifacts/` path, so no registry or source checkout is required.

The committed `.tsx-lvgl/framework.lock.json` is the provenance pin:

```json
{
  "formatVersion": 1,
  "package": "@tsx-lvgl/sdk",
  "version": "0.1.0",
  "sourceSha": "<40 lowercase hex characters>",
  "artifact": {
    "file": ".tsx-lvgl/artifacts/tsx-lvgl-sdk-0.1.0.tgz",
    "sha256": "<64 lowercase hex characters>",
    "byteLength": 12345
  }
}
```

`sync` installs that exact artifact. `update` explicitly repackages a
machine-configured source checkout and replaces the pin; dirty source checkouts
are rejected so the SHA-only provenance cannot hide uncommitted changes.
Installation delegates to the package manager declared or detected by the
consumer (npm, pnpm, Yarn Classic v1 or bun); the application source and committed
framework metadata do not encode an npm-only install path.
`dev` and `build` verify the pin and do not silently upgrade it. A generated consumer `AGENTS.md`
defines ownership, safe operations and the distinction between headless/build
evidence and physical-device proof. Verdaccio is intentionally not part of the
seam; an npm-compatible registry can replace the artifact source later without
changing application imports or normal commands.

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

## Bundle producer

`@tsx-lvgl/bundler` converts one TSX entry into one deterministic JavaScript
bundle plus a manifest:

- Transform: TypeScript compiler API, `jsx: react-jsx` with import source
  `@tsx-lvgl/core`, `module: CommonJS`, `target: ES2020`, LF newlines,
  comments removed. The bundle's `export default` is the root component.
- Output is ASCII-only: every code unit >= 0x80 is escaped as `\uXXXX`, so
  `byteLength === code.length` and the device decodes bytes to a string
  without `TextDecoder`.
- Determinism by construction: no timestamps, no absolute paths, no
  environment-dependent output. Repeated builds are byte-identical.
- The bundler computes `sha256` (lowercase hex) and `byteLength` into the
  manifest. `validateRuntimeBundle` stays shape-only; byte verification is
  the transport's job.
- Bounds: `RUNTIME_BUNDLE_MAX_BYTES = 262144` (256 KiB), exported from
  `@tsx-lvgl/runtime` and mirrored by one C `#define`. Rationale: QuickJS
  heap limit is 1 MiB; the staged copy lives in PSRAM; the MVP app is a few
  KiB, so 256 KiB bounds staging and parse cost with wide headroom.
- Identity: the supported V1 target uses
  `boardId = "waveshare.esp32s3.touch-amoled-1.8.v1"`. This is a
  bundle/firmware compatibility target, not physical identity evidence. Only
  V1 is supported by this release; adding a catalog record alone does not
  claim hardware support. `protocolVersion = 1`, `engine = "quickjs-ng"`, and
  `format = "js"` remain unchanged.
- Breaking change (board-target selection): existing projects whose committed
  `tsx-lvgl.json` still carries the legacy `boardId`
  `"waveshare.esp32s3.touch-amoled-1.8"` fail with `BOARD_TARGET_UNSUPPORTED`
  on every `dev`/`build`. Migration is manual: replace the value with the
  canonical `.v1` ID above or rerun `tsx-lvgl create --board
  waveshare.esp32s3.touch-amoled-1.8.v1`. Legacy IDs are rejected, never
  silently remapped, so a project cannot drift onto the wrong hardware
  revision.
- Dev reload is not authenticated. The sha256 check is integrity only;
  production OTA/signatures remain out of scope and this transport must not
  be presented as secure.

## Device kernel

The compiled `core + sensors + runtime + device` packages form a "kernel"
bundle baked into firmware (`EMBED_FILES`); the reconciler runs inside
QuickJS on the device. Only the app bundle hot-reloads; kernel changes ride
the guarded firmware path. C exposes a `__native` object (contract:
`packages/device/src/native.ts`) — low-level LVGL ops, timers, sync sensor
read, click dispatch, log. The kernel wires it to the runtime seams and
tracks `lastGeneration` in RAM (baked-in app = generation 1; rejected or
rolled-back reloads do not consume a generation). On the host the identical
engine adapter (`createProgramEngine`) evaluates bundles in Node; the
manifest `engine` name asserts bundle-format compatibility, not interpreter
identity. QuickJS-specific behavior stays a board-gate concern.

## Bundle transport v1 (dev only)

Line-oriented ASCII over the USB Serial/JTAG console, `\n`-terminated.
Staging is RAM only (`RUNTIME_BUNDLE_MAX_BYTES` in PSRAM); the transport
never touches flash and never calls a firmware flashing operation. Bundle A
stays live until the kernel commits B.

Host to device:

- `TSXB BEGIN <base64(manifest JSON)>`
- `TSXB DATA <seq> <base64 payload, <= 384 chars>` — `seq` starts at 1,
  strictly increments.
- `TSXB END <chunkCount>`
- `TSXB ABORT`

Device to host:

- `TSXB RDY maxBytes=<n> protocol=<v> board=<id> lastGeneration=<g>` —
  reply to `BEGIN`.
- `TSXB ACK <seq>` — per accepted chunk.
- `TSXB OK bundle=<id> generation=<g> epoch=<e>` — committed.
- `TSXB ERR <reason>` — terminal for this attempt. `reason` is one of the
  nine `RuntimeBundleRejection` values or `frame`, `base64`, `sequence`,
  `overflow`, `sha256`, `timeout`, `busy`, `malformed-manifest`,
  `non-ascii`, `evaluate-rolled-back`, `hardware-mismatch`, or
  `hardware-unknown`.

Before the V1 display/runtime composition starts, the adapter performs a
bounded, read-only identity check through the existing BSP I2C owner. An ACK
at `0x38` with a reliable NACK at `0x15` is the only V1 `matched` result. An
ACK at `0x15` is V2 `mismatch`, including when the `0x38` probe errors; both
ACKs are ambiguous `unknown`; error combinations without a unique positive ACK
are `unknown`. Identity is logged as one bounded checkpoint:
`PROBE checkpoint=board_identity status=pass|mismatch|unknown target=<id>
evidence=<code>`.

If identity is not matched, the target does not create display, provider,
QuickJS, or app state. A minimal diagnostic transport remains available:
`TSXB BEGIN` receives exactly one terminal hardware error, with no `RDY`,
staging allocation, `DATA` ACK, or runtime generation call. The protocol
grammar and version remain unchanged. A matched target keeps the ready-mode
handshake and optional touch/motion capability semantics unchanged.

Rules:

- Timeouts: device discards staging after 2000 ms without a valid frame
  mid-transfer; host waits 1000 ms per `ACK` and 5000 ms for `OK`/`ERR`
  after `END` (evaluation budget).
- After `END`, device checks staged length == `manifest.byteLength` and
  mbedTLS sha256 == `manifest.sha256`, then hands off to the kernel at the
  owner-task quiescent point (between pumps, under the display lock).
- Any `ERR`, host-detected protocol error, missing `ACK`, or timeout: host sends
  best-effort `TSXB ABORT` and exits non-zero; device frees staging and bundle A
  keeps running. A device-reported `ERR` is terminal already, so its redundant
  `ABORT` is accepted as a no-op.
- Sequence gap or duplicate → `ERR sequence`. Payload overflow past
  `maxBytes` → `ERR overflow`. A transfer while one is active → `ERR busy`.
- Non-`TSXB` lines in either direction are noise (device logs interleave on
  the same console) and must be ignored, never treated as protocol errors.
- Teardown sets a cooperative stop flag and joins the transport through the
  full reload handoff budget plus a scheduling margin. A join timeout returns
  failure and retains the task, reload request references, queue, and staging
  state for the owner-task cleanup retry; it never force-deletes a live task.

### Consumer device development command

`tsx-lvgl dev --device --port <serial-port> [--json]` watches the app entry
configured in `tsx-lvgl.json`. It builds the initial bundle immediately, then
coalesces saves and sends each accepted bundle through the line-channel
adapter. The TSXB session remains pure and testable; Node serial streams are
injected at the CLI edge. On each `RDY` whose `lastGeneration` is not below the
configured generation, the host sends `ABORT` and retries exactly once with
`lastGeneration + 1`. It never persists that negotiated value or the local
port. A compile/transport failure reports the rejection and keeps the last
accepted app running so the next save can recover. A second stale generation,
bad protocol identity, device error or either timeout fails that push
deterministically without terminating the watch session.

`tsx-lvgl doctor --device --port <serial-port>` checks only serial-port syntax;
it never opens a serial device. Neither command calls a flashing, reset, reload
or firmware/security mutation path. Device push/rollback/soak is therefore a
separate physical acceptance gate.

## M1 tracer bullet

The deterministic host path proves the slice diagrammed in
[the runtime architecture](../architecture.md#first-vertical-slice).

`Runtime.reloadBundle` covers the bundle-to-engine seam with a fake evaluator;
the real QuickJS-NG adapter remains a board-host gate.

The committed physical runtime-port probe under
`examples/esp-idf/components/tsx_runtime_probe` plus the V1 target composition
proves only QuickJS-NG, direct LVGL
calls, timer delivery, sensor-shaped data and touch callback feasibility on
the target. Board captures and other transient physical evidence are not
committed; the probe is not reconciler or hot-reload evidence.

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
