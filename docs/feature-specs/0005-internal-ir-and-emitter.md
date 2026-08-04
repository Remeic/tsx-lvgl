# Feature 0005 — internal semantic IR and LVGL emitter seam

## Problem

The current tracer bullet exposes the semantic node shape and lowers LVGL directly inside the compiler. That makes the public vocabulary and target backend evolve as one coupled switch, contrary to the intended emitter boundary.

## Proposed outcome

Keep authoring types public, move validated semantic IR behind an internal package seam, and make the LVGL emitter a replaceable adapter with exhaustive handling.

## Architecture

```mermaid
flowchart LR
    TSX[Public TSX vocabulary] --> Core[@tsx-lvgl/core]
    Core --> Normalize[Internal IR normalization]
    Normalize --> IR[Opaque semantic IR]
    IR --> Emitter[@tsx-lvgl/lvgl-emitter]
    Emitter --> LVGL[LVGL 9 C]
    IR --> Future[Future target emitter]
```

## Acceptance criteria

- [ ] Consumers cannot construct or depend on the internal IR shape through the public package entry point.
- [x] `@tsx-lvgl/lvgl-emitter` owns LVGL-specific lowering and has an exhaustive unsupported-node diagnostic.
- [x] Compiler tests exercise the emitter through the compiler public seam, not private object mutation.
- [ ] Adding a second target does not require changing TSX authoring types.
- [x] Mutation scope includes the deterministic compiler and emitter modules.

## Test plan

Golden artifacts, invalid-node diagnostics and target-specific emitter tests remain separate. No board code is required for this host architecture slice.
