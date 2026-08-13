# Framework development workflow

## 1. Run the host gates

The reproducible path uses the pinned development container and Docker Desktop:

```bash
./tools/dev test
./tools/dev mutation
```

For a fast host-only iteration when Node.js 24.19.0 and npm 11.17.0 are already
installed:

```bash
npm ci
npm run typecheck
npm test
```

The host runner exercises the same bundle, runtime and host contracts without
requiring a board:

```bash
./tools/run-host --entry tests/fixtures/shakeface-a.tsx --shake
```

## 2. Build and try a bundle

Build a new generation of an app bundle:

```bash
node scripts/bundle-app.mjs \
  --entry tests/fixtures/shakeface-a.tsx \
  --out build/bundles \
  --bundle-id shakeface \
  --generation 2
```

If a development probe is already running and its serial port is available,
push that bundle without reflashing:

```bash
./tools/push-bundle --port /dev/cu.usbmodemXXX \
  --bundle build/bundles/shakeface.g2.js \
  --manifest build/bundles/shakeface.g2.manifest.json
```

The generation must be greater than the currently running generation; replace
`2` with the next unused generation when repeating the workflow. This command
is a bundle push, not an installer: it assumes a running probe and a host-side
serial bridge. Docker Desktop for Mac does not provide USB passthrough by
itself; see [the development environment guide](development-environment.md)
and [the recovery protocol](recovery.md) before attempting physical-board
work.

The transport is development-only, integrity-checked and unauthenticated. It
uses RAM/PSRAM staging, never writes flash and must not be treated as a secure
OTA or production update channel.

App-only changes use this bundle path. Changes to the kernel, native bindings,
board host or baked-in application require regenerating the embedded artifacts
and rebuilding firmware; see the
[runtime-port probe guide](../examples/esp-idf/runtime_port_probe/README.md).

For the persistent example-app workflow, use the single guarded command below.
It defaults to Pomodoro, keeps `--execute` explicit, regenerates the stable
embedded `app.g1.*` artifacts, rebuilds the firmware and then delegates the
physical write to `board:reload`:

```bash
npm run board:install -- \
  --app pomodoro \
  --port /dev/cu.usbmodemXXX \
  --recovery-dir /path/to/board-recovery \
  --esptool-python /path/to/esptool-5.3.1-venv/bin/python \
  --execute
```

Omit `--execute` (or pass `--dry-run`) to build and inspect the guarded plan
without opening the board. The public app-facing `tsx-lvgl dev --device`
command remains the fast RAM hot-reload path; it intentionally does not flash.

## 3. Build the runtime-port probe

The committed runtime-port probe is the development runtime host for the
target board: it boots the embedded kernel, mounts the persistent app selected
by `board:install` (Pomodoro by default), and then accepts hot-reloaded bundles
over the dev transport. Build it with
the pinned toolchain:

```bash
./tools/dev qemu \
  "cd examples/esp-idf/runtime_port_probe && idf.py build"
```

Do not flash directly. Flashing only happens through the guarded board
workflow after the recovery and identity gates in
[the recovery protocol](recovery.md) pass.
