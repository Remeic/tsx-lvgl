# TSX-LVGL

<p align="center">
  <img src="assets/tsx-lvgl-logo.png" alt="TSX-LVGL" width="720">
</p>

<p align="center"><strong>Typed TSX interfaces compiled to native LVGL for small screens.</strong></p>

<p align="center">
  <a href="https://github.com/Remeic/tsx-lvgl/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/Remeic/tsx-lvgl/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
</p>

TSX-LVGL is an independent experiment for writing declarative interfaces in TypeScript/TSX and compiling them into readable, native LVGL 9 C for ESP32-class hardware.

The first hardware target is the Waveshare ESP32-S3-Touch-AMOLED-1.8. The same generated C should also run against LVGL's desktop SDL driver, so the simulator and the device exercise one UI artifact.

## What TSX-LVGL is

- build-time TSX authoring with a deliberately bounded, typed UI vocabulary;
- a semantic intermediate representation kept behind the compiler interface;
- native LVGL 9 output, with no JavaScript engine on the microcontroller;
- an integer-only fixed-tree state subset lowered to native LVGL callbacks;
- a narrow board adapter so the compiler remains independent from display drivers;
- desktop SDL parity and generated-source tests before hardware flashing.

## What TSX-LVGL is not

TSX-LVGL is not React, is not affiliated with React or Meta, and does not claim to compile arbitrary React applications. React is an inspiration for the authoring ergonomics; the device target is native LVGL firmware.

## Target API

```tsx
/** @jsxImportSource @tsx-lvgl/react */

import { Button, Screen, Text, useState } from "@tsx-lvgl/react";

function Counter() {
  const [count, setCount] = useState(0);
  return <Screen>
    <Text text={count} />
    <Button label="+" onClick={() => setCount(previous => previous + 1)} />
  </Screen>;
}

export default Counter;
```

This is the supported React-shaped authoring subset. Read the [MVP
compatibility contract](docs/react-mvp.md) before relying on semantics beyond
this example.

## The first MVP artifact

```tsx
function Counter() {
  const [count, setCount] = useState(0);
  const increment = () => setCount(previous => previous + 1);
  return <Screen><Text text={count} /><Button label="+" onClick={increment} /></Screen>;
}

export default Counter;
```

Success means the same generated C:

1. passes compiler and native-host tests;
2. renders in SDL;
3. builds with the pinned ESP-IDF toolchain;
4. builds into the pinned ESP-IDF V1 application using Waveshare BSP 1.1.4;
5. remains separate from physical-board and recovery gates.

## Project shape

```text
packages/core          TSX types and the supported authoring vocabulary
packages/compiler      source analysis, private native lowering and compileProject
packages/lvgl-emitter  legacy core-tree to LVGL 9 C adapter
packages/react         React-shaped compatibility authoring module
apps/simulator         LVGL 9.5.0 SDL build using the generated C
apps/esp-idf-v1        pinned ESP-IDF V1 integration target
examples/              source-entry fixtures
docs/                  architecture and operational recovery decisions
```

The module interfaces are intentionally small. Complexity should live behind deep modules and clean seams, not in every application screen.

## Development

The first host-side compiler slice remains available through `compileProject`.
The React-shaped MVP adds source-entry `compileProject({ entryFile })`, static local composition,
integer-only fixed-tree state, real LVGL SDL coverage and the V1 ESP-IDF
integration target. The physical board still needs the documented arrival,
backup and restore gates before any custom firmware is considered.

The supported reproducible path requires Docker Desktop as the only host prerequisite. It builds the pinned development image and runs the project commands inside it:

```bash
./tools/dev test
./tools/dev c-compile
./tools/dev simulator
./tools/dev esp-idf-v1
./tools/dev parity
./tools/dev mutation
```

The container owns Node.js 24.19.0, npm 11.17.0, ESP-IDF 5.5.5, QEMU and the native build tools. `tools/dev` mounts the checkout, bootstraps dependencies from the lockfile and remains non-interactive in CI while preserving an interactive terminal locally. No host Node.js or ESP-IDF installation is required for the reproducible path. See [the development environment guide](docs/development-environment.md).

The host-only fast path remains available when the pinned toolchain is already installed:

```bash
npm ci
npm test
npm run test:c
npm run mutation
```

These commands build all workspace packages, typecheck the TSX fixtures, run
host tests, compile generated C and execute mutation testing. When the native
toolchain is installed locally, `npm run simulator:test` and
`npm run esp-idf:v1:build` add the real LVGL SDL and V1 ESP-IDF gates; the
pinned container commands above are the reproducible reference for those
gates.

The public container command ladder was historically validated from a fresh GitHub checkout. The pre-MVP baseline for this README was commit [`996914e`](https://github.com/Remeic/tsx-lvgl/commit/996914ea878a4f92bf9c232a18fb1bd2fa20d483), with [CI evidence](https://github.com/Remeic/tsx-lvgl/actions/runs/30928995488):

- 17/17 host tests passing;
- generated-C compilation passing;
- mutation score 100.00%: 232 mutants killed, 0 survived and 0 timed out;
- image `sha256:b76d0b9bc0b553d928301c059826275b2c53969d88e25e40443aa5601165765d`;
- validation artifact [container-validation-996914e...](https://github.com/Remeic/tsx-lvgl/actions/runs/30928995488/artifacts/8900621645).

This validates software and the pinned development container, not the physical
board. SDL and ESP-IDF builds do not prove panel/touch/power behavior; USB
flashing, display/touch behavior and factory-state recovery remain explicit
hardware gates. See [the compatibility and evidence boundary](docs/react-mvp.md).

Read [the architecture decision](docs/architecture.md) and [the recovery protocol](docs/recovery.md) before adding code.

## License

Project-owned code is MIT licensed. Third-party code and notices remain under their original licenses.
