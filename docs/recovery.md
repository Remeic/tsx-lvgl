# Board arrival and recovery

This document is the repository policy for the physical Waveshare ESP32-S3-Touch-AMOLED-1.8 board. The per-unit manifest and raw image stay outside Git because a full flash dump can contain credentials and provisioning data.

The current unit is V1: SH8601 display, FT3168 touch, ESP32-S3, 8 MiB PSRAM and 16 MiB external flash. The V2 path is different hardware (CO5300/CST820) and must never be applied to this board.

## Current gate

The current unit's arrival manifest is `HARD STOP`: B/C are independently acquired, byte-identical full-flash reads; the factory baseline is recorded; and two plaintext external copies were previously verified under a documented owner exception because encrypted media were unavailable. Both media became unavailable during final pre-write validation, so their current availability must be re-established before another fresh, separately logged same-session identity/security preflight. The manifest alone never authorizes a physical write. A complete-size candidate A remains explicitly untrusted and is not a recovery image.

## Full-flash dump custody

Treat every full-flash dump and its associated identity/security reports as sensitive recovery material.

- Store it encrypted at rest using an approved, access-controlled encrypted volume or vault; do not leave plaintext dumps on shared disks.
- Restrict access to the minimum named maintainers needed for recovery. Do not share dumps through chat or email.
- Keep exactly two controlled copies: the encrypted working/recovery copy and one separately controlled encrypted recovery copy. Record the owner and location outside this repository.
- Create and retain a SHA-256 checksum alongside each copy; verify it after copying and immediately before any restore.
- Retain the copies only for the approved recovery window. At expiry, securely delete every copy and its temporary plaintext working files, then record the deletion outside this repository.
- Do not place dumps, reports, keys, tokens, or checksums in unapproved cloud-sync folders. Never add them to Git, a Docker build context, issue attachments, or CI artifacts.

## Non-negotiable order

1. Protect the recovery directory and keep all artifacts owner-readable only.
2. Photograph the board and rear label; preserve photo provenance privately.
3. Boot and record a concrete factory baseline: cold boot, screen, touch, controls, power and selected exposed peripherals.
4. Identify V1 from the rear label and record the board-to-MCU identity evidence.
5. Read chip, flash capacity/JEDEC ID, MAC, optional unique ID, security and complete eFuse state.
6. Take two separately acquired reads of the complete 16 MiB external flash.
7. Require successful command logs, exact size, byte equality, valid image/partition structure and a recorded SHA-256.
8. Verify two encrypted archive copies in independent failure domains.
9. Keep restore disabled until a guarded same-unit procedure and objective cold-boot criteria are recorded.

The recovery image does not restore eFuses, physical damage, PSRAM, RTC/PMIC state, SD-card contents or other external/peripheral state. Any eFuse/security change invalidates this generic raw-flash path.

## Recovery environment

Use an isolated esptool 5.3.1 environment separate from the ESP-IDF environment. Record Python and installed distribution inventory before relying on it; this environment has no `pip`, so `pip freeze` is not an available reproducibility proof.

```bash
umask 077
RECOVERY_PY="/absolute/path/to/esptool-5.3.1-venv/bin/python"
BOARD_PORT="/dev/cu.ACTUAL_VERIFIED_DEVICE"
ARRIVAL_DIR="/absolute/path/to/arrival-backup-YYYYMMDD"
```

`BOARD_PORT` is transport only. It must be selected for the current session and never treated as device identity.

## Read-only identity gate

Capture each command, complete output and exit status into a timestamped preflight record. Compare all of the following with the per-unit manifest before accepting the gate:

- ESP32-S3 QFN56 and revision;
- MAC `1c:db:d4:7a:06:60`;
- optional unique ID `35 04 64 13 aa f6 0e 7e 7f 9c b2 57 97 1d 95 12`;
- flash manufacturer/device `0x20 / 0x4018` and detected size `16MB`;
- Secure Boot, Flash Encryption, `SPI_BOOT_CRYPT_CNT`, secure download and relevant eFuse fields;
- V1 physical identity: SH8601/FT3168.

The esptool/espefuse 5.3.1 command forms are:

```bash
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" flash-id
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" read-mac
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" get-security-info
"$RECOVERY_PY" -m espefuse --chip esp32s3 --port "$BOARD_PORT" summary
"$RECOVERY_PY" -m espefuse --chip esp32s3 --port "$BOARD_PORT" dump
```

Stop on every mismatch or unknown field. Never use a write to test identity. `RD_DIS`/`WR_DIS` state is evidence only; eFuses are not restored by the flash image.

## Two full reads

Each read must be a separate successful operation with a fresh identity preflight. Never overwrite an accepted artifact. Use a unique temporary destination, retain the command transcript/exit code, validate before promotion, and only create the final A/B names when the destination is absent.

The logical operation is:

```bash
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" --baud 460800 read-flash 0x0 0x1000000 <unique-a-output>
"$RECOVERY_PY" -m esptool --chip esp32s3 --port "$BOARD_PORT" --baud 460800 read-flash 0x0 0x1000000 <unique-b-output>
test <size-a> -eq 16777216
test <size-b> -eq 16777216
cmp <a> <b>
shasum -a 256 <a>
```

`0x1000000` is exactly `16,777,216` bytes. A/B must be independently acquired, not copied. The accepted candidate must also pass offline ESP32-S3 image/partition-structure validation. If the transport is unstable, record the failure and use a separately documented lower baud acquisition; do not overwrite a prior candidate.

Do not write anything while any read, size, equality, checksum, structure or archive gate is pending.

## Security-state decision matrix

| Confirmed state | Full read | Generic same-board raw restore | Required path |
|---|---|---|---|
| Flash encryption disabled, secure boot disabled, secure download restrictions disabled | Allowed only after the complete two-read gate | Potentially allowed only on the same physical MCU with all manifest gates passing | Per-unit guarded procedure; current unit remains blocked |
| Flash encryption enabled | Do not assume a dump is portable or usable | Not allowed by this generic procedure | Validated signed/encrypted update and key/provisioning procedure |
| Secure boot enabled | Do not assume an arbitrary dump is bootable | Not allowed by this generic procedure | Exact signed-image recovery procedure |
| Secure download mode or any restriction not understood | Stop; do not probe with writes | Forbidden | Device-specific read-only-supported procedure |
| Any eFuse, MCU, flash, power or hardware damage | Flash image is insufficient | Forbidden | Hardware-specific recovery or replacement |

If any security field is unknown, stop before reading for acceptance and before every write. QEMU or an official image does not authorize a physical-board restore path.

## Restore — disabled until the manifest passes

No standalone write command is published while the per-unit manifest is in hard-stop status. When a future manifest explicitly enables it, the guarded procedure must:

1. append a pre-write `START` record;
2. recheck same-device identity and security/eFuse state in the same session;
3. recheck size, A/B equality, SHA-256, structure and archive verification;
4. use the actual verified port, never a stale path;
5. keep `--flash-mode keep --flash-freq keep --flash-size keep` explicit;
6. capture stdout/stderr and exit status;
7. require esptool's immediate post-write data verification before treating transport as successful;
8. handle power/USB/host-sleep/BOOT state as explicit preconditions;
9. perform post-restore identity and functional checks, then close the operation log with a terminal result.

Esptool 5.3.1 uses `hard-reset` by default. A separate `verify-flash` after that reset is not automatically a proof of byte stability because factory code may mutate NVS/OTA state between commands. The eventual procedure must use a validated no-application-run verification sequence or clearly separate immediate transport verification from post-boot functional verification.

Never use `--force`, preliminary erase, eFuse writes or an official image as a substitute for the unit's own validated dump.

## PASS/FAIL criteria

Overall PASS requires:

- guarded write exit `0` and immediate data verification success;
- post-operation MAC, optional unique ID, chip/revision, flash ID/size and security/eFuse state matching;
- two complete cold boots matching the recorded factory baseline;
- display, touch, controls, USB identity, power behavior and each selected peripheral test marked `PASS`;
- complete operation log with artifacts, hashes and no unexplained interruption.

Any mismatch, missing evidence, serial loss, non-zero exit, hash/verification failure, unknown eFuse state or functional difference is `FAIL/UNKNOWN`. Do not mark the board recovered.

## Artifact protection

Recovery artifacts must use `umask 077`, files `0600`, directories `0700`, encrypted archives and two independent failure domains. Record each archive's medium/path, encryption status, SHA-256 and verification timestamp. The current candidate A is not accepted and must not be presented as either archive.
