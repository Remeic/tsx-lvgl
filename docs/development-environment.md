# Development environment

The supported reproducible path is the Dev Container. Install Docker Desktop once, clone the repository, and run:

```bash
./tools/dev test
./tools/dev c-compile
./tools/dev simulator
./tools/dev esp-idf-v1
./tools/dev mutation
```

The container pins ESP-IDF 5.5.5, its toolchain/QEMU tools, Node.js 24.19.0,
npm 11.17.0 and the SDL development headers used by the LVGL 9.5.0 simulator.
The image is pinned by digest and the Node archives are checksum-verified for
Apple Silicon and Intel hosts.

Each `./tools/dev` invocation reconciles the pinned image (using Docker's build cache) and bootstraps `npm ci` inside the mounted checkout when dependencies are absent or the lockfile is newer. A fresh clone therefore needs no host Node installation.

GitHub Actions also builds this exact Dockerfile on `ubuntu-24.04` through the public `./tools/dev` path from a fresh checkout. The blocking container job runs `test`, `c-compile`, `mutation`, `simulator` and `esp-idf-v1`, records the image ID/tool versions and uploads the command output. The host and mutation jobs remain separate so container parity does not hide host-specific regressions.

`./tools/dev qemu` remains a separate optional emulator command. The
`esp-idf-v1` command now builds the V1 application and records the standard
ESP-IDF size output; it does not flash or prove physical behavior.

The physical board is a separate gate. Docker Desktop for Mac does not provide direct USB passthrough; use an explicitly documented host serial bridge only after the recovery identity and factory-backup gates are complete. Never put dumps, credentials or board-specific provisioning data in the mounted repository.

The host Node/npm path remains available as a fast contributor option, but CI and the container are the reproducibility reference.

`test:c` uses the checked-in LVGL stub for warnings-as-errors syntax checks and
also links tiny host fixtures that exercise both signed-32-bit saturation
boundaries without requiring LVGL or a board.
