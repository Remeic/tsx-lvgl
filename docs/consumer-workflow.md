# Consumer application workflow

The supported local distribution boundary is a standard npm-pack artifact. A
machine bootstrap builds one artifact from a framework checkout and installs it
into an application; the application then works without a registry and without
the framework checkout:

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

When a development runtime is already running on a locally attached board, keep
this command running. It pushes the initial bundle immediately, then watches
the entry configured in `tsx-lvgl.json` and pushes each accepted save without
reflashing firmware:

```bash
<package-manager> run dev -- --device --port /dev/cu.usbmodemXXX --json
<package-manager> run doctor -- --device --port /dev/cu.usbmodemXXX --json
```

`dev --device` uses the TSXB development transport for every accepted build,
negotiates one monotonic generation from the board's `RDY lastGeneration` reply,
and makes at most one retry per push. Rapid saves are coalesced, builds and
pushes are serialized, and a failed build or push leaves the last accepted app
running while the watcher waits for the next save. The port and negotiated
generation stay in memory for that invocation; they are never written to
`tsx-lvgl.json`, the framework lock, or other portable project files.
`doctor --device` only validates local port syntax and does not open, reset,
flash, or otherwise touch a board.

## Package managers

The application commands use the package manager declared in the app's
`package.json`, selected by its lockfile or inherited from the invoking package
manager. The framework checkout commands above remain npm workspace commands.
Yarn support is limited to Yarn Classic v1 because the consumer contract expects
`node_modules`; Yarn Berry/PnP is not supported by this CLI.

## Framework lock

The generated `.tsx-lvgl/framework.lock.json` records the framework source SHA,
artifact version, SHA-256 and byte length. `sync` installs that exact artifact;
`update` is the explicit command that repackages a machine-configured source
checkout. `dev` and `build` verify the lock and never upgrade it. A source path
may be supplied through `TSX_LVGL_SOURCE` or the machine-only
`~/.config/tsx-lvgl/config.json`; it is never written to application config.
The generated `AGENTS.md` records the same ownership and safety rules.

The CLI emits stable diagnostic codes and supports JSON output on all commands
that produce a result. The public `@tsx-lvgl/sdk` package and its `tsx-lvgl`
binary are private and protected from accidental publication; the package
source seam can later be replaced by an npm-compatible registry without
changing application imports or commands.
