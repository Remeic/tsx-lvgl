# TSX-LVGL runtime probe

Dev runtime host for the ESP32-S3 V1 board: the compiled `core + sensors +
runtime + device` packages ("kernel") plus a small `ShakeFace` verification app baked in as
bundle generation 1, both embedded at build time. On boot the probe evaluates
the kernel, mounts the verification fixture, and then accepts hot-reloaded app bundles over
a dev-only USB Serial/JTAG transport — no reflash required to try a new app
bundle. It is not a product path or release artifact; this committed source
and build harness proves the runtime-first architecture on the physical
target, while board captures remain transient evidence. See
[feature spec 0010](../../../docs/feature-specs/0010-runtime-tsx-hot-reload.md)
for the normative contracts (native ABI, bundle format, transport wire
protocol).

`ShakeFace` (`tests/fixtures/shakeface-a.tsx`) is an internal verification fixture
only, not a published example.

## Regenerate the embedded bundles

From the repository root, after any change to `tests/fixtures/shakeface-a.tsx`
or the `core`/`sensors`/`runtime`/`device` packages:

```bash
node scripts/bundle-app.mjs --entry tests/fixtures/shakeface-a.tsx \
  --out examples/esp-idf/runtime_port_probe/main \
  --bundle-id shakeface --generation 1
node scripts/build-kernel.mjs
```

This writes `main/shakeface.g1.js`, `main/shakeface.g1.manifest.json` and
`main/kernel.js` (all three `EMBED_TXTFILES` in `main/CMakeLists.txt`, so a
kernel/app change needs a firmware rebuild — only later hot-reloaded bundles
skip that).

## Build without flashing

```bash
./tools/dev shell
# inside the container:
cd examples/esp-idf/runtime_port_probe && idf.py build
```

The component manager resolves `espressif/quickjs-ng` 0.14.0, LVGL 9.5 and
the Waveshare V1 BSP 1.1.4. Generated dependency/build output (`build/`,
`managed_components/`, `sdkconfig`) is local and gitignored;
`dependencies.lock` is tracked (mirrors `examples/esp-idf/tsx_lvgl_v1`).

Do not use `idf.py flash` directly. Flashing only happens through the guarded
board workflow (`tools/board-reload`) after its external recovery and
identity gates pass — this example's transport never writes flash.

## UART checkpoints

On a physical V1 board, capture UART/USB console output and check it with:

```bash
node tools/check-runtime-probe.mjs <log-file> [--require-reload]
```

Baseline (boot only), required:

```text
PROBE checkpoint=engine_cycles status=pass
PROBE checkpoint=js_eval status=pass
PROBE checkpoint=lvgl_binding status=pass
PROBE checkpoint=imu_init status=pass
PROBE checkpoint=sensor_read status=pass
PROBE checkpoint=timer_callback status=pass
PROBE checkpoint=kernel_start status=pass
PROBE checkpoint=app_mount status=pass
```

With `--require-reload` (push at least one bundle and one deliberately
rejected bundle during capture):

```text
PROBE checkpoint=bundle_reload status=pass
PROBE checkpoint=bundle_reject status=pass
```

Shake the board and verify visually that the face toggles happy/sad (and the
status label reads "IMU non disponibile" if the QMI8658 read fails).

## Pushing a hot-reloaded bundle (dev only)

Build a new generation and push it over the probe's USB Serial/JTAG port
while it's running:

```bash
node scripts/bundle-app.mjs --entry tests/fixtures/shakeface-a.tsx \
  --out /tmp/shakeface-g2 --bundle-id shakeface --generation 2
./tools/push-bundle --port /dev/cu.usbmodemXXX \
  --bundle /tmp/shakeface-g2/shakeface.g2.js \
  --manifest /tmp/shakeface-g2/shakeface.g2.manifest.json
```

This is the "Bundle transport v1 (dev only)" protocol: line-oriented ASCII
(`TSXB BEGIN`/`DATA`/`END`/`ABORT` and `RDY`/`ACK`/`OK`/`ERR` replies) over the
same USB Serial/JTAG console that carries `ESP_LOGx` output. It stages bytes
in PSRAM only, is not authenticated, and must never be treated as a secure or
production channel — see spec 0010's transport section for the full state
machine, timeouts and error vocabulary. It never flashes; only
`tools/board-reload` does, under its own guarded gates.
