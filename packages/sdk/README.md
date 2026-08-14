# `@tsx-lvgl/sdk`

`@tsx-lvgl/sdk` is the supported application seam for TSX-LVGL. The framework
workspace stays private; the release packer builds a self-contained, public
registry artifact that vendors the framework implementation and records its
source provenance. Contributors can also make the same portable artifact for
an offline local bootstrap workflow.

Applications import UI tags and hooks from `@tsx-lvgl/sdk` and use the
`tsx-lvgl` command for `create`, `sync`, `update`, `dev`, `check`, `build` and
`doctor`. The package bundles the framework implementation needed by those
commands, so the application does not depend on a framework checkout or a
registry. The CLI uses the package manager declared in the app's
`package.json`, the invoking package-manager environment, or its lockfile
(npm, pnpm, Yarn Classic v1 or bun); application source and portable framework metadata do
not hardcode npm-specific install behavior.

Discovery and base command construction use the pinned, zero-dependency
`package-manager-detector` library. The SDK adds only TSX-LVGL policy: stable
diagnostics, offline and lifecycle-script flags, lock conflict handling, and a
fresh Bun cache for same-version local artifacts.

For consumers, install the published package and use its CLI:

```bash
npm install --global @tsx-lvgl/sdk
tsx-lvgl create my-app
```

For release commands and the required trusted-publishing setup, see
[`RELEASING.md`](https://github.com/Remeic/tsx-lvgl/blob/main/RELEASING.md).

`tsx-lvgl dev --device --port <serial-port> [--json]` is an optional
development-only bundle push. It never flashes or resets firmware. The port is
machine-local and the generation negotiated from the board is invocation-only;
neither is stored in application configuration. `doctor --device --port ...`
performs only the same syntax preflight and does not open the port.
