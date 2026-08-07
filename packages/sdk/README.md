# `@tsx-lvgl/sdk`

This private package is the supported application seam for TSX-LVGL. It is
distributed through an npm-pack tarball during the local bootstrap workflow;
it is intentionally not publishable.

Applications import UI tags and hooks from `@tsx-lvgl/sdk` and use the
`tsx-lvgl` command for `create`, `sync`, `update`, `dev`, `check`, `build` and
`doctor`. The package bundles the framework implementation needed by those
commands, so the application does not depend on a framework checkout or a
registry.
