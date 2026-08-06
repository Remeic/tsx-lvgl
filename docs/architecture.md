# Architecture decision

Status: accepted for the first implementation slice.

## Core decision

TSX-LVGL runs TypeScript/TSX on the development machine and emits native LVGL 9 C. The ESP32 receives no JavaScript runtime, React Fiber tree or dynamic module loader.

This preserves the useful part of the React idea—composition, declarative trees and typed props—without pretending that arbitrary browser React semantics can be compiled to a deterministic microcontroller firmware.

## Modules and interfaces

### `core`

Public interface: the legacy static TSX vocabulary and its exact prop types.

The interface must remain smaller than raw LVGL. It contains only capabilities that can be validated, generated and tested consistently.

### `compiler`

Deep public interface:

```ts
compileProject(config: CompileConfig): BuildArtifacts
```

The interface includes diagnostics, deterministic output rules and asset/compiler-version metadata. TypeScript analysis, component evaluation and the semantic IR stay inside the implementation. The IR is an internal seam, not a public format in v0.

### `lvgl-emitter`

Adapter for the legacy core tree at the IR-to-firmware seam. It lowers
validated legacy nodes to readable LVGL 9 C and knows LVGL; it does not know
Waveshare pins, USB or board revision. Source-entry compilation uses a
compiler-private native target emitter after the parser has produced the same
opaque, typed internal program; neither native program nor native emitter is a
package-root API.

The first host tracer bullet remains available through the legacy `UiNode`
path. The React MVP keeps its semantic program private to the compiler target
seam; neither package root exports `NativeProgram`, `NativeNode`, or action
constructors.

### `boards`

Board adapter seam for display initialization, touch input, LVGL tick, flush, power and optional peripherals. The V1 applications use the pinned Waveshare SH8601/FT3168 BSP 1.1.4. `apps/esp-idf-v1` consumes the React MVP counter artifact for SDL/ESP parity; `examples/esp-idf/tsx_lvgl_v1` remains the legacy-core tracer bullet used by the guarded app-only reload workflow. These are intentionally separate targets, and the compiler never imports a board adapter.

### `simulator`

The simulator compiles the exact generated C and native runtime against LVGL SDL. It is not a second renderer. This makes screenshot tests meaningful: a passing simulator build and a passing embedded build share the same UI artifact.

## v0 language contract

Implemented MVP: `Screen`, `View`, `Text` and `Button`, fragments,
zero-argument static function composition, integer-only `useState`, native
event callbacks, minimal flex layout, deterministic LVGL C, LVGL 9.5.0 SDL
coverage and a V1 ESP-IDF integration target. The legacy static tree remains
available for compatibility tests.

Deferred: `Image`, `Stack`, arbitrary styles, scalar values other than bounded
integers, derived values, visibility/enabled bindings, props, lists and dynamic
tree expansion.

Also rejected: arbitrary React imports, effects/context/suspense, runtime-created
component types, DOM/CSS compatibility, hot reload, and an unrestricted
native-widget escape hatch.

Every addition needs compiler diagnostics, generated-C coverage, native-host coverage and SDL coverage before it becomes part of the public interface.

Known follow-up: `packages/compiler/src/source.ts` still combines source collection,
validation, lowering, diagnostics and identity allocation. Splitting those
responsibilities is maintainability debt for a later bounded change; this MVP
does not expand the monolith further.

## Quality gates

- identical source and config produce byte-identical generated artifacts;
- generated C compiles with warnings treated as errors;
- host tests cover signal updates, events, cleanup and object-count stability;
- SDL screenshots cover layout and visual regressions;
- ESP-IDF builds use pinned versions and record firmware-size headroom;
- custom firmware is not flashed before the board's factory state is backed up and restorable.

The legacy host compiler evaluates a root component twice and rejects divergent
artifacts within one invocation. The source-entry compiler instead parses the
bounded TSX subset, so hook order, component-instance paths and native update
targets are deterministic by construction. Both paths still require pinned
tool/environment inputs for reproducible builds.
