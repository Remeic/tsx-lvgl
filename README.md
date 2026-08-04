# Lume

**Typed TSX interfaces compiled to native LVGL for small screens.**

Lume is an independent experiment for writing declarative interfaces in TypeScript/TSX and compiling them into readable, native LVGL 9 C for ESP32-class hardware.

The first hardware target is the Waveshare ESP32-S3-Touch-AMOLED-1.8. The same generated C should also run against LVGL's desktop SDL driver, so the simulator and the device exercise one UI artifact.

## What Lume is

- build-time TSX authoring with a deliberately bounded, typed UI vocabulary;
- a semantic intermediate representation kept behind the compiler interface;
- native LVGL 9 output, with no JavaScript engine on the microcontroller;
- explicit signals, derived values and events lowered to native LVGL mechanisms;
- a narrow board adapter so the compiler remains independent from display drivers;
- desktop SDL parity and generated-source tests before hardware flashing.

## What Lume is not

Lume is not React, is not affiliated with React or Meta, and does not claim to compile arbitrary React applications. React is an inspiration for the authoring ergonomics; the device target is native LVGL firmware.

## The first tracer bullet

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
packages/lvgl-emitter  semantic IR to LVGL 9 C
packages/runtime       small native support library for generated UI
boards/                display, touch, power and tick adapters
apps/simulator         LVGL SDL build using the generated C
docs/                  architecture and operational recovery decisions
```

The module interfaces are intentionally small. Complexity should live behind deep modules and clean seams, not in every application screen.

## Status

Pre-alpha. The development host and the official Waveshare baseline are prepared; the physical board still needs the documented arrival, backup and restore gates before custom firmware is flashed.

Read [the architecture decision](docs/architecture.md) and [the recovery protocol](docs/recovery.md) before adding code.

## License

Project-owned code is MIT licensed. Third-party code and notices remain under their original licenses.
