# TSX-LVGL

<p align="center">
  <img src="assets/tsx-lvgl-logo.png" alt="TSX-LVGL" width="720">
</p>

<p align="center">
  <a href="https://github.com/Remeic/tsx-lvgl/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/Remeic/tsx-lvgl/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
</p>

<p align="center"><strong>Runtime TSX interfaces for LVGL on ESP32-S3.</strong></p>

TSX-LVGL is an embedded UI experiment for authoring a bounded TypeScript/TSX
component model, bundling it as JavaScript, and running that bundle on a
device-owned runtime. The first hardware target is the Waveshare
ESP32-S3-Touch-AMOLED-1.8 (V1: SH8601 display and FT3168 touch).

## Runtime path

The TSX→bundle→engine→VNode→reconciler→LVGL pipeline diagram lives in
[the runtime architecture](docs/architecture.md#core-decision).

The runtime owns component identity, state/effect lifecycle, event replacement,
typed sensor access, scheduler handoff and transactional bundle epochs. Native
C is limited to the ESP-IDF/board/LVGL/sensor boundary. UI is not generated as
C. See [Feature 0010](docs/feature-specs/0010-runtime-tsx-hot-reload.md) for
detail.

## M1 tracer bullet

The current host slice proves:

```tsx
function Counter() {
  const [count, setCount] = useState(0);
  const uptime = useSensor(boardUptime);
  useInterval(() => setCount((value) => value + 1), 1000);

  return (
    <Screen>
      <Text text={`count=${count} uptime=${uptime?.value ?? "?"}`} />
      <Button label="increment" onClick={() => setCount((value) => value + 1)} />
    </Screen>
  );
}
```

Deterministic tests cover lazy immutable VNodes, keyed state preservation,
host operations, event/timer disposal, typed sensor validation, reload epochs
and rollback. The real QuickJS-NG/LVGL/touch probe remains a separate hardware
feasibility gate; passing host tests does not prove board readiness.

## Dev loop (bundle hot reload)

Edit a TSX app, rebuild its bundle, push it to a running dev firmware — no
reflash:

```bash
node scripts/bundle-app.mjs --entry examples/apps/ShakeFace.tsx --out build/bundles --generation 2
tools/push-bundle --port /dev/cu.usbmodemXXX \
  --bundle build/bundles/shakeface.g2.js \
  --manifest build/bundles/shakeface.g2.manifest.json
```

A committed bundle swaps the UI transactionally; a malformed, oversized or
throwing bundle is rejected/rolled back and the running app stays live. The
same path runs on the host without hardware: `tools/run-host --entry
examples/apps/ShakeFace.tsx --shake`. Protocol and guarantees:
[Feature 0010](docs/feature-specs/0010-runtime-tsx-hot-reload.md). The dev
transport is integrity-checked but unauthenticated; it is not OTA and never
flashes firmware.

## Project shape

```text
packages/core       immutable VNodes and TSX vocabulary
packages/runtime    reconciler, hooks, engine seam and reload transaction
packages/sensors    versioned typed capabilities and samples
packages/bundler    deterministic TSX->JS bundle + manifest, transport framing
packages/device     kernel glue: LVGL host over the native ABI, scheduler, sensors
examples/apps       internal dev apps (ShakeFace)
examples/esp-idf    board host: QuickJS-NG kernel + TSXB bundle transport
docs/               architecture, feature and recovery evidence
```

The repository retains only a frozen generated-C firmware artifact for guarded
board recovery while runtime gates are open. It is not an alternate runtime
path and receives no new features; Git history is the source rollback. The
guarded board recovery process remains in force and must not be bypassed.

## Development

Use the pinned repository environment when available. The local fast path is:

```bash
npm install
npm test
npm run build
```

The committed runtime-port probe under `examples/esp-idf/runtime_port_probe`
is a separate feasibility harness, not physical proof; board captures and
other transient evidence are not committed. Do not flash directly. Read
[the recovery protocol](docs/recovery.md) and use the guarded app-only board
workflow only after the external identity, security and recovery gates pass.

## Evidence boundaries

QuickJS-NG feasibility, host reconciliation, simulator behavior, ESP-IDF
builds, QEMU, physical display/touch behavior and recovery are separate gates.
The transient FT3168/I2C warm-reset failure remains open; see the
[diagnosis note](docs/diagnostics/ft3168-i2c-reset.md).

## License

Project-owned code is MIT licensed. Third-party code and notices remain under
their original licenses.
