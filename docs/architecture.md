# Architecture decision

Status: accepted for the first implementation slice.

## Core decision

TSX-LVGL runs TypeScript/TSX on the development machine and emits native LVGL 9 C. The ESP32 receives no JavaScript runtime, React Fiber tree or dynamic module loader.

This preserves the useful part of the React idea—composition, declarative trees and typed props—without pretending that arbitrary browser React semantics can be compiled to a deterministic microcontroller firmware.

## Modules and interfaces

### `core`

Public interface: the supported TSX vocabulary, prop types, styles, signals and event declarations.

The interface must remain smaller than raw LVGL. It contains only capabilities that can be validated, generated and tested consistently.

### `compiler`

Deep public interface:

```ts
compileProject(config: CompileConfig): BuildArtifacts
```

The interface includes diagnostics, deterministic output rules and asset/compiler-version metadata. TypeScript analysis, component evaluation and the semantic IR stay inside the implementation. The IR is an internal seam, not a public format in v0.

### `lvgl-emitter`

Adapter at the IR-to-firmware seam. It lowers validated IR to readable LVGL 9 C and a small native runtime. It knows LVGL; it does not know Waveshare pins, USB or board revision.

The first host tracer bullet now has this adapter in `packages/lvgl-emitter`. The semantic `UiNode` shape is still structural and visible to the first public tests; issue #4 tracks making that IR opaque without weakening the compiler seam.

### `boards`

Board adapter seam for display initialization, touch input, LVGL tick, flush, power and optional peripherals. V2 uses the managed Waveshare BSP path. V1, if the delivered board requires it, gets an explicit SH8601 adapter. The compiler never imports a board adapter.

### `simulator`

The simulator compiles the exact generated C and native runtime against LVGL SDL. It is not a second renderer. This makes screenshot tests meaningful: a passing simulator build and a passing embedded build share the same UI artifact.

## v0 language contract

Implemented first: `Screen`, `View`, `Text` and `Button` with typed props, a static tree and deterministic LVGL C emission. This is the host-side tracer bullet that lets us validate the compiler seam before the board arrives.

Next in the same contract: `Image`, `Stack`, finite styles, scalar signals, derived values, visibility/enabled bindings, events and build-time list expansion.

Deferred: arbitrary React imports, hooks/effects/context/suspense, runtime-created component types, DOM/CSS compatibility, hot reload and an unrestricted native-widget escape hatch.

Every addition needs compiler diagnostics, generated-C coverage, native-host coverage and SDL coverage before it becomes part of the public interface.

## Quality gates

- identical source and config produce byte-identical generated artifacts;
- generated C compiles with warnings treated as errors;
- host tests cover signal updates, events, cleanup and object-count stability;
- SDL screenshots cover layout and visual regressions;
- ESP-IDF builds use pinned versions and record firmware-size headroom;
- custom firmware is not flashed before the board's factory state is backed up and restorable.

The deterministic host compiler evaluates a root component twice and rejects divergent generated artifacts within one invocation. This catches stateful roots that change their output, but cannot prove that an opaque JavaScript function is pure across separate invocations. Reproducible builds therefore require pure components plus pinned tool and environment inputs; a controlled evaluator remains tracked in issue #7.
