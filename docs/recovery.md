# Board arrival and recovery

This document is the short repository policy. The detailed working checklist lives in the Codex readiness dossier; keep its evidence outside Git because a full flash dump can contain credentials and provisioning data.

## Non-negotiable order

1. Photograph the board and rear label.
2. Boot and record the factory behavior.
3. Identify V1 or V2 from the rear label.
4. Read chip, flash capacity, MAC, security and eFuse state.
5. Take two independent reads of the complete 16 MiB external flash.
6. Require exact size and byte equality; archive the dump in two places.
7. Demonstrate restore and cold-boot behavior before serious development.

The V2 path is ESP-IDF 5.5.5 + Waveshare BSP 2.0.3 + LVGL 9. The current managed BSP always constructs the CO5300 display, so an original/V1 board must use the first-party V1 baseline and an explicit SH8601 adapter.

## Recovery environment

Use an isolated esptool 5.3.1 environment. Keep it separate from the ESP-IDF environment used to compile applications.

```bash
RECOVERY_PY="/absolute/path/to/esptool-5.3.1-venv/bin/python"
BOARD_PORT="/dev/cu.ACTUAL_DEVICE"
ARRIVAL_DIR="$PWD/arrival-backup-YYYYMMDD"
mkdir -p "$ARRIVAL_DIR"
```

## Read-only identity gate

```bash
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" flash-id \
  | tee "$ARRIVAL_DIR/flash-id.txt"
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" read-mac \
  | tee "$ARRIVAL_DIR/read-mac.txt"
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" get-security-info \
  | tee "$ARRIVAL_DIR/security-info.txt"
"$RECOVERY_PY" -m espefuse --chip esp32s3 --port "$BOARD_PORT" summary \
  > "$ARRIVAL_DIR/efuse-summary.txt"
"$RECOVERY_PY" -m espefuse --chip esp32s3 --port "$BOARD_PORT" dump \
  > "$ARRIVAL_DIR/efuse-dump.txt"
```

Stop if the device is not an ESP32-S3 with 16 MiB flash, if the revision is unclear, or if security restrictions are not understood. Never use `--force`, `erase-flash` as a preliminary step, or any `burn-*` eFuse command.

## Two full reads

```bash
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" --baud 460800 \
  read-flash 0x0 0x1000000 "$ARRIVAL_DIR/factory-16mb-a.bin"
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" --baud 460800 \
  read-flash 0x0 0x1000000 "$ARRIVAL_DIR/factory-16mb-b.bin"
test "$(stat -f '%z' "$ARRIVAL_DIR/factory-16mb-a.bin")" -eq 16777216
test "$(stat -f '%z' "$ARRIVAL_DIR/factory-16mb-b.bin")" -eq 16777216
cmp "$ARRIVAL_DIR/factory-16mb-a.bin" "$ARRIVAL_DIR/factory-16mb-b.bin"
shasum -a 256 "$ARRIVAL_DIR/factory-16mb-a.bin" \
  | tee "$ARRIVAL_DIR/factory-16mb.sha256"
```

Do not write anything until both reads are exactly 16,777,216 bytes and byte-identical. If the read is unstable, lower the baud rate and repeat both reads.

## Security-state decision matrix

The raw full-flash recipe below is permitted only after the identity gate proves the first row. Security state is a safety boundary, not a detail to infer after writing.

| Confirmed state | Full read | Generic same-board raw restore | Required path |
| --- | --- | --- | --- |
| Flash encryption disabled, secure boot disabled, secure download restrictions disabled | Allowed after the two-read gate | Allowed with size/checksum/MAC/security comparison | This document's dump/write/verify sequence |
| Flash encryption enabled | Do not assume a dump is a portable or usable backup | Not allowed by this generic procedure | Validated signed/encrypted update and key/provisioning procedure for the exact device |
| Secure boot enabled | Do not assume an arbitrary dump is bootable | Not allowed by this generic procedure | Exact signed-image recovery procedure for the configured secure-boot mode |
| Secure download mode or any restriction not understood | Stop; do not probe with write commands | Forbidden | Obtain a device-specific, read-only-supported recovery procedure |

If any security field is unknown, stop before `read-flash` and before every write. QEMU can exercise reversible security workflows, but it does not authorize a physical-board restore path.

## Restore

For the first row only, restore to the same physical board after validating size and checksum and comparing the current MAC/security output with the saved reports:

```bash
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" --baud 460800 \
  write-flash 0x0 "$ARRIVAL_DIR/factory-16mb-a.bin"
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" --baud 460800 \
  verify-flash 0x0 "$ARRIVAL_DIR/factory-16mb-a.bin"
```

Release BOOT, power-cycle fully and validate the recorded factory display, touch, power and exposed peripherals. Official revision-matched Waveshare images are a fallback, not a replacement for the personal dump.
