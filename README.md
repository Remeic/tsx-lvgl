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
- a planned path for explicit signals, derived values and events lowered to native LVGL mechanisms;
- a narrow board adapter so the compiler remains independent from display drivers;
- desktop SDL parity and generated-source tests before hardware flashing.

## What TSX-LVGL is not

TSX-LVGL is not React, is not affiliated with React or Meta, and does not claim to compile arbitrary React applications. React is an inspiration for the authoring ergonomics; the device target is native LVGL firmware.

## Target API sketch (not implemented yet)

```tsx
const count = signal(0);

export function Counter() {
  return (
    <Screen>
      <Text text={count} />
      <Button label="+" onClick={() => count.set(count.get() + 1)} />
    </Screen>
  );
}
```

This is the intended reactive API, not the current implementation. The host tracer bullet currently supports a static `Text`/`Button` tree with `action` strings; signals and `onClick` are future work.

## The first tracer bullet

```tsx
export function Counter() {
  return (
    <Screen>
      <Text text={0} />
      <Button label="+" action="increment" />
    </Screen>
  );
}
```

Success means the same generated C:

1. passes compiler and native-host tests;
2. renders in SDL;
3. builds with the pinned ESP-IDF toolchain;
4. renders and accepts touch on the AMOLED board;
5. can be followed by a verified factory-state restore.

## Project shape

```text
packages/core          TSX types and the supported authoring vocabulary
packages/compiler      TSX analysis and compileProject(config)
packages/lvgl-emitter  semantic IR to LVGL 9 C adapter (IR opacity in issue #4)
packages/runtime       small native support library for generated UI
boards/                planned display, touch, power and tick adapters
apps/simulator         planned LVGL SDL build using the generated C (issue #8)
docs/                  architecture and operational recovery decisions
```

The module interfaces are intentionally small. Complexity should live behind deep modules and clean seams, not in every application screen.

## Development

The first host-side compiler slice is implemented: imported TSX components become a typed `UiNode` tree and `compileProject` emits deterministic LVGL 9 C plus a manifest. The development host and official Waveshare baseline are prepared; the physical board still needs the documented arrival, backup and restore gates before custom firmware is flashed.

The supported reproducible path requires Docker Desktop as the only host prerequisite. It builds the pinned development image and runs the project commands inside it:

```bash
./tools/dev test
./tools/dev c-compile
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

These commands build all workspace packages, typecheck the TSX test fixture, run the native host tests, compile the generated C and execute mutation testing.

The public container command ladder is continuously validated from a fresh GitHub checkout. The verified baseline for this README is commit [`996914e`](https://github.com/Remeic/tsx-lvgl/commit/996914ea878a4f92bf9c232a18fb1bd2fa20d483), with [CI evidence](https://github.com/Remeic/tsx-lvgl/actions/runs/30928995488):

- 17/17 host tests passing;
- generated-C compilation passing;
- mutation score 100.00%: 232 mutants killed, 0 survived and 0 timed out;
- image `sha256:b76d0b9bc0b553d928301c059826275b2c53969d88e25e40443aa5601165765d`;
- validation artifact [container-validation-996914e...](https://github.com/Remeic/tsx-lvgl/actions/runs/30928995488/artifacts/8900621645).

This validates the development container, not the physical board. `./tools/dev qemu` remains gated on the ESP-IDF application in [issue #8](https://github.com/Remeic/tsx-lvgl/issues/8); USB flashing, display/touch behavior and factory-state recovery remain explicit hardware gates.

Read [the architecture decision](docs/architecture.md) and [the recovery protocol](docs/recovery.md) before adding code.

## License

Project-owned code is MIT licensed. Third-party code and notices remain under their original licenses.
