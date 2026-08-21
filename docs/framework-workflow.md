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
  --generation 2 \
  --board-id tsx-lvgl.host-test
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
  --target waveshare-touch-amoled-1.8-v1 \
  --port /dev/cu.usbmodemXXX \
  --recovery-dir /path/to/board-recovery \
  --esptool-python /path/to/esptool-5.3.1-venv/bin/python \
  --execute
```

The successful target build generates a descriptor beside the firmware image.
It proves the partition-table read offset from the generated ESP-IDF
`build/flasher_args.json` `flash_files` mapping; the board profile does not
provide a fallback offset. Missing or inconsistent build metadata stops
descriptor generation.
Before any app-only mutation, the guarded reload reads the live `0x1000`-byte
partition sector and requires an exact semantic match for the descriptor and
selected application partition. A V2/stock layout mismatch stops safely; the
workflow never selects another slot or rewrites the partition table.

Omit `--execute` (or pass `--dry-run`) to build and inspect the read-only plan
without opening the board. For an operator-authorized logged read-only check,
use `--execute --preflight-only`; this validates the live layout and then stops
before write, verify or reset. The public app-facing `tsx-lvgl dev --device`
command is the long-lived RAM hot-reload path for a consumer project; it
intentionally does not flash. The framework-only `npm run dev:board` helper
accepts an explicit entry for direct examples and uses the same watcher.

First-time provisioning is not part of app-only reload and remains blocked until
the separate Plan 006 workflow records its own recovery and security evidence.

## 3. Build the runtime-port probe

The committed runtime-port probe is the development runtime host for the
target board: it boots the embedded kernel, mounts the persistent app selected
by `board:install` (Pomodoro by default), and then accepts hot-reloaded bundles
over the dev transport. Build it with the target-aware helper and pinned
toolchain:

```bash
npm run board:build -- --target waveshare-touch-amoled-1.8-v1
```

Do not flash directly. Flashing only happens through the guarded board
workflow after the recovery and identity gates in
[the recovery protocol](recovery.md) pass.
