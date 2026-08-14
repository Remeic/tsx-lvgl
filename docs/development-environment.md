# Development environment

The supported reproducible path is the Dev Container. Install Docker Desktop once, clone the repository, and run:

```bash
./tools/dev test
./tools/dev mutation
```

`npm test` (and the container `test` command) enforces 100% line, branch and
function coverage for the runtime packages. `npm run mutation` enforces 100%
mutation score with zero survivors, timeouts or errors.

The container pins ESP-IDF 5.5.5, its toolchain/QEMU tools, Node.js 24.19.0 and npm 11.17.0. The image is pinned by digest and the Node archives are checksum-verified for Apple Silicon and Intel hosts.

Each `./tools/dev` invocation reconciles the pinned image (using Docker's build cache) and bootstraps `npm ci` inside the mounted checkout when dependencies are absent or the lockfile is newer. A fresh clone therefore needs no host Node installation.

GitHub Actions also builds this exact Dockerfile on `ubuntu-24.04` through the public `./tools/dev` path from a fresh checkout. The blocking container job runs `test`, records the image ID/tool versions and uploads the command output. The dedicated host mutation job is the single CI mutation owner; container parity does not hide host-specific regressions.

Use `./tools/dev qemu` for an explicit emulator command when the target image and emulator support it. A physical runtime-port probe on the ESP32-S3 board (not committed in this change) is a separate firmware/build gate, not QEMU or physical-board evidence.

The physical board is a separate gate. Docker Desktop for Mac does not provide direct USB passthrough; use an explicitly documented host serial bridge only after the recovery identity and factory-backup gates are complete. Never put dumps, credentials or board-specific provisioning data in the mounted repository.

The host Node/npm path remains available as a fast contributor option, but CI and the container are the reproducibility reference.
