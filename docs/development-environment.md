# Development environment

The supported reproducible path is the Dev Container. Install Docker Desktop once, clone the repository, and run:

```bash
./tools/dev test
./tools/dev c-compile
./tools/dev mutation
```

The container pins ESP-IDF 5.5.5, its toolchain/QEMU tools, Node.js 24.19.0 and npm 11.17.0. The image is pinned by digest and the Node archives are checksum-verified for Apple Silicon and Intel hosts.

Each `./tools/dev` invocation reconciles the pinned image (using Docker's build cache) and bootstraps `npm ci` inside the mounted checkout when dependencies are absent or the lockfile is newer. A fresh clone therefore needs no host Node installation.

GitHub Actions also builds this exact Dockerfile on `ubuntu-24.04`, records the image ID and tool versions, and runs `npm test` plus `npm run test:c` inside the image. The host and mutation jobs remain separate so container parity does not hide host-specific regressions.

`./tools/dev qemu` is reserved for the ESP-IDF application introduced by issue #8. Until that application exists, use the host compiler and C checks above; do not infer QEMU or hardware evidence from an empty command.

The physical board is a separate gate. Docker Desktop for Mac does not provide direct USB passthrough; use an explicitly documented host serial bridge only after the recovery identity and factory-backup gates are complete. Never put dumps, credentials or board-specific provisioning data in the mounted repository.

The host Node/npm path remains available as a fast contributor option, but CI and the container are the reproducibility reference.
