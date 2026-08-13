# Consumer application workflow

`@tsx-lvgl/sdk` is the public npm package for application authors. It includes
the `tsx-lvgl` CLI and the supported SDK facade; applications do not need a
framework checkout:

```bash
npm install --global @tsx-lvgl/sdk
tsx-lvgl create ./my-app
cd my-app
<package-manager> run doctor -- --json
<package-manager> run dev
<package-manager> run check
<package-manager> run build
```

## Offline framework workflow

Framework contributors can use the equivalent standard npm-pack artifact when
working without registry access. The artifact is built from a framework
checkout, then installed into the application; the application subsequently
works without that checkout:

```bash
npm run build
npm run pack:sdk -- --out /tmp/tsx-lvgl-sdk
tsx-lvgl create ./my-app --artifact /tmp/tsx-lvgl-sdk/tsx-lvgl-sdk-0.1.0.tgz
cd my-app
<package-manager> run doctor -- --json
<package-manager> run dev
<package-manager> run check
<package-manager> run build
```

## Device-backed dev mode

When a development runtime is already running on a locally attached board,
one command builds and pushes the app bundle without reflashing firmware:

```bash
<package-manager> run dev -- --device --port /dev/cu.usbmodemXXX --json
<package-manager> run doctor -- --device --port /dev/cu.usbmodemXXX --json
```

`dev --device` uses the TSXB development transport, negotiates one monotonic
generation from the board's `RDY lastGeneration` reply, and makes at most one
retry. The port and negotiated generation stay in memory for that invocation;
they are never written to `tsx-lvgl.json`, the framework lock, or other
portable project files. `doctor --device` only validates local port syntax and
does not open, reset, flash, or otherwise touch a board.

## Package managers

The application commands use the package manager declared in the app's
`package.json`, selected by its lockfile or inherited from the invoking package
manager. The framework checkout commands above remain npm workspace commands.
Yarn support is limited to Yarn Classic v1 because the consumer contract expects
`node_modules`; Yarn Berry/PnP is not supported by this CLI.

## Framework lock

The generated `.tsx-lvgl/framework.lock.json` records the framework source SHA,
artifact version, SHA-256 and byte length. `sync` installs that exact artifact;
`update` is the explicit command for repackaging a machine-configured source
checkout or selecting a new artifact. `dev` and `build` verify the lock and
never upgrade it. A source path may be supplied through `TSX_LVGL_SOURCE` or the machine-only
`~/.config/tsx-lvgl/config.json`; it is never written to application config.
The generated `AGENTS.md` records the same ownership and safety rules.

The CLI emits stable diagnostic codes and supports JSON output on all commands
that produce a result. The source workspace package remains private to prevent
an incomplete direct publish; releases publish only the self-contained registry
artifact. Both registry and offline artifacts provide the same
`@tsx-lvgl/sdk` imports and `tsx-lvgl` binary.
