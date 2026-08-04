# Feature 0009 — one-command development environment

## Problem

ESP-IDF, QEMU, CMake/Ninja, cross-compilers, Python tools, Node and host test dependencies are a large and drift-prone installation surface. Contributors should not need to reproduce it manually on macOS.

## Proposed outcome

Provide one pinned container-based development environment. A contributor installs Docker Desktop once, clones the repository and runs documented commands; the repository owns the Node, ESP-IDF, QEMU and simulator tool versions. Physical USB flashing remains an explicit host bridge because Docker Desktop for Mac does not provide transparent USB passthrough.

## Architecture

```mermaid
flowchart LR
    Clone[Clone repository] --> Docker[One Docker prerequisite]
    Docker --> Dev[Pinned dev container]
    Dev --> Host[Node tests + mutation + C compile]
    Dev --> QEMU[ESP-IDF + QEMU tests]
    Host --> BoardBridge[Explicit host USB bridge]
    QEMU --> BoardBridge
    BoardBridge --> Board[Physical board smoke]
```

## Acceptance criteria

- [ ] `.devcontainer` or an equivalent pinned container image contains Node, ESP-IDF, QEMU, CMake/Ninja, Python tools and simulator dependencies.
- [ ] `./tools/dev test`, `./tools/dev mutation`, `./tools/dev qemu` and `./tools/dev c-compile` work from a fresh clone after Docker Desktop installation.
- [x] Tool versions and the built image ID are recorded; the base image uses an immutable digest and no implicit `latest` tag is used.
- [ ] Host-only development remains possible as an optional fast path, not a second source of truth.
- [ ] Physical flashing/serial access is documented as a separate, explicit host bridge with recovery safeguards.
- [x] CI builds this exact container definition and runs the host/C checks inside it.

## Test plan

The first CI slice builds the container on GitHub's x86_64 Linux runner, records the image ID and Node/npm/ESP-IDF versions, and runs `npm test` plus `npm run test:c` inside the image. Apple Silicon build evidence, the container mutation/QEMU ladder and the physical USB/display/touch gates remain open. Do not claim USB or panel parity from the container alone.
