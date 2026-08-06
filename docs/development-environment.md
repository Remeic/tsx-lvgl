# Development environment

The supported reproducible path is the Dev Container. Install Docker Desktop once, clone the repository, and run:

```bash
./tools/dev test
./tools/dev c-compile
./tools/dev simulator
./tools/dev esp-idf-v1
./tools/dev mutation
```

The guarded legacy-core tracer bullet has a separate software path:

```bash
npm run generate:board
npm run board:build
npm run board:reload -- --dry-run
```

`board:build` targets `examples/esp-idf/tsx_lvgl_v1`; `./tools/dev esp-idf-v1`
targets the React MVP artifact under `apps/esp-idf-v1`. Both are software-only
builds. The reload dry run prints an app-only plan and performs no hardware or
recovery-directory access.

The container pins ESP-IDF 5.5.5, its toolchain/QEMU tools, Node.js 24.19.0,
npm 11.17.0 and the SDL development headers used by the LVGL 9.5.0 simulator.
The image is pinned by digest and the Node archives are checksum-verified for
Apple Silicon and Intel hosts.

Each `./tools/dev` invocation reconciles the pinned image (using Docker's build cache) and bootstraps `npm ci` inside the mounted checkout when dependencies are absent or the lockfile is newer. A fresh clone therefore needs no host Node installation.

GitHub Actions also builds this exact Dockerfile on `ubuntu-24.04` through the public `./tools/dev` path from a fresh checkout. The blocking container job runs `test`, `c-compile`, `simulator`, `esp-idf-v1` and `parity`, records the image ID/tool versions and uploads the command output. The dedicated macOS/host mutation job is the sole CI mutation execution: after `npm ci` it runs `npm run mutation` and uploads the SHA-bound mutation reports. Host, mutation and container jobs remain separate so container parity does not hide host-specific regressions.

`./tools/dev qemu` remains a separate optional emulator command. The
`esp-idf-v1` command now builds the V1 application and records the standard
ESP-IDF size output; it does not flash or prove physical behavior.

The physical board is a separate gate. Docker Desktop for Mac does not provide direct USB passthrough; use an explicitly documented host serial bridge only after the recovery identity and factory-backup gates are complete. Never put dumps, credentials or board-specific provisioning data in the mounted repository.

The host Node/npm path remains available as a fast contributor option, but CI and the container are the reproducibility reference.

`test:c` uses the checked-in LVGL stub for warnings-as-errors syntax checks and
also links tiny host fixtures that exercise both signed-32-bit saturation
boundaries without requiring LVGL or a board.
