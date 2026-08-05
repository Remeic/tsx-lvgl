# TSX-LVGL ESP32-S3 V1 tracer bullet

This is the first ESP-IDF application that consumes the generated TSX-LVGL C
artifact on the delivered Waveshare V1 board.

The target is intentionally pinned to the V1 BSP `1.1.4`, whose board adapter
uses the SH8601 display and FT3168 touch controller. Do not change this to the
2.x BSP: that path uses the newer CO5300/CST816S hardware family.

The application also matches the recorded unit configuration: ESP32-S3,
16 MiB flash, DIO at 80 MHz, and 8 MiB octal PSRAM. ESP-IDF resolves the
component graph into `dependencies.lock`; that file is reviewed and committed
after a successful build so later images use the same dependency set.

## Generate and build only

From the repository root:

```bash
npm run generate:board
./tools/dev qemu "cd examples/esp-idf/tsx_lvgl_v1 && idf.py set-target esp32s3 && idf.py build"
```

The command above builds the application inside the pinned development
container. It does not connect to USB and does not flash a device.

## Physical flashing gate

Do not run `idf.py flash` yet. The per-unit recovery manifest outside Git must
first be `PASS`, with the factory behavior baseline and two independently
verified encrypted archives recorded. Any future physical operation needs a
new `START` entry in that unit's operation log.
