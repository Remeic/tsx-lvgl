# TSX-LVGL ESP32-S3 V1 tracer bullet

This is frozen legacy firmware: the committed `main/tsx_generated_ui.c` from
the retired generated-C path. It is kept only so the guarded board
reload/recovery workflow keeps a known-good app to build and flash; it is not
the runtime product path and receives no new features. See
[docs/architecture.md](../../../docs/architecture.md) for the current
runtime-first architecture.

The target is intentionally pinned to the V1 BSP `1.1.4`, whose board adapter
uses the SH8601 display and FT3168 touch controller. Do not change this to the
2.x BSP: that path uses the newer CO5300/CST816S hardware family.

The application also matches the recorded unit configuration: ESP32-S3,
16 MiB flash, DIO at 80 MHz, and 8 MiB octal PSRAM. ESP-IDF resolves the
component graph into `dependencies.lock`; that file is reviewed and committed
after a successful build so later images use the same dependency set.

## Build only

From the repository root:

```bash
npm run board:build -- --target waveshare-touch-amoled-1.8-v1
```

This builds the committed firmware inside the pinned development container.
It does not regenerate C and does not connect to USB or flash a device.

## Physical flashing gate

Do not run `idf.py flash` directly. The per-unit recovery manifest outside Git
and its same-session identity/security/eFuse gate must pass before any physical
write. Any physical operation needs a new `START` entry in that unit's
operation log.

For development reloads, use the guarded app-only wrapper from the repository
root. It builds the image, creates the external recovery log before opening the
serial port, validates the same board, writes only the factory app partition at
`0x10000`, verifies the bytes, and requests a watchdog reset rather than relying
only on the RTS reset path:

```bash
export ESPTOOL_PYTHON="/absolute/path/to/esptool-5.3.1-venv/bin/python"
export TSX_LVGL_RECOVERY_DIR="/absolute/path/to/arrival-backup-YYYYMMDD"
npm run board:reload -- --target waveshare-touch-amoled-1.8-v1 --port /dev/cu.ACTUAL_DEVICE --execute
```

Use `npm run board:reload -- --target waveshare-touch-amoled-1.8-v1 --dry-run` to inspect the command plan without
touching hardware. The wrapper never authorizes bootloader/partition writes,
global erase, eFuse operations or paths under `/Volumes`. The watchdog-reset
mode is a transport candidate and still needs one logged physical validation;
display and touch remain separate user-visible checks.

## Visible hot-reload test

The diagnostic build adds three labels below the generated button:

```text
HOT RELOAD TEST
boot N / reset R
reload => boot +1
```

After the first successful boot, run one guarded reload while watching the
display. The test is a PASS only if the same screen returns without unplugging
USB/power, `boot N` increases by one, and the existing button still changes
from `Touch me` to `Touched`. A power-cycle is a separate baseline check and
may reset the counter; it must not be used to claim the warm-reset test passed.
