# Feature 0001 — host-side compiler tracer bullet

> Superseded by Feature 0010. Retained as historical evidence; generated-C UI
> is no longer an active product path.
> Its acceptance checklist is historical and is not an active release gate.

## Problem

Before the ESP32 arrives, we need a small vertical slice that proves the repository's authoring, compiler and generated-output seams without depending on physical hardware.

## Proposed outcome

Compile a TSX component tree containing `Screen`, `Text`, `View` and `Button` into deterministic LVGL 9 C plus a manifest. The output must be testable on the host and ready to become the board application's generated input.

## Architecture

```mermaid
flowchart LR
    TSX[Typed TSX components] --> Core[@tsx-lvgl/core JSX runtime]
    Core --> IR[UiNode semantic tree]
    IR --> Compiler[compileProject]
    Compiler --> Emitter[LVGL 9 C emitter]
    Emitter --> Artifacts[generated/ui.c + manifest]
    Artifacts --> Host[Node native-host tests]
    Artifacts --> Future[ESP-IDF board adapter]
```

## Acceptance criteria

- [x] `Screen`, `View`, `Text` and `Button` have typed authoring interfaces.
- [x] `compileProject` emits `generated/ui.c` and a deterministic manifest.
- [x] Nested children use their actual LVGL parent object.
- [x] C string literals are escaped correctly.
- [x] Two compilations of the same source/config produce identical artifacts.
- [x] `npm test` passes on Node 24.19.0.
- [ ] Generated C is compiled into the first ESP-IDF board application after arrival.
- [ ] The generated UI is rendered and touched on the physical board.

## Test evidence

The current host evidence is in `tests/compiler.test.tsx` and runs through `npm test`. Hardware criteria remain intentionally open until the board arrival and recovery gates pass.
