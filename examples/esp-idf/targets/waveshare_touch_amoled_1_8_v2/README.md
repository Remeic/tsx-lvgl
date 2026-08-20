# Waveshare ESP32-S3 Touch AMOLED 1.8 V2 target

Status: `experimental-build-only`.

This is a separate ESP-IDF composition root. It is not a runtime switch in the
V1 firmware. Consumer SDK/install tooling continues to reject this board ID
until the physical and recovery gates pass.

## Explicit target identity

| Field | Value |
|---|---|
| Build target | `waveshare-touch-amoled-1.8-v2` |
| Canonical firmware ID | `waveshare.esp32s3.touch-amoled-1.8.v2` |
| Project | `examples/esp-idf/targets/waveshare_touch_amoled_1_8_v2` |
| Adapter | `components/tsx_board_adapter_v2` |
| Application partition | `factory`, offset `0x10000`, size `0x800000` |
| First-time stock V2 write | Blocked by Plan 006 and the live partition gate |

Build the target only with the explicit key:

```bash
npm run board:build -- --target waveshare-touch-amoled-1.8-v2
```

The build writes the V2 image, generated target-ID header and target-bound
descriptor under this target's `build/` directory. Build output is not proof
that a physical display or touch controller is fitted.

## BSP and managed component pins

The direct manifest pins the Waveshare BSP to `2.0.3` and pins the directly
used V2 display, touch and expander components. The checked-in lock is the
source of the exact resolved versions:

| Component | Exact resolved version |
|---|---:|
| `waveshare/esp32_s3_touch_amoled_1_8` | `2.0.3` |
| `espressif/esp_lcd_co5300` | `2.1.0` |
| `espressif/esp_lcd_touch_cst816s` | `1.1.2` |
| `espressif/esp_io_expander_tca9554` | `2.0.3` |
| `espressif/esp_lcd_panel_io_additions` | `1.0.1~1` |
| `espressif/esp_lvgl_port` | `2.9.0` |
| `lvgl/lvgl` | `9.5.0` |
| `espressif/quickjs-ng` | `0.14.0` |
| ESP-IDF lock entry | `5.5.5` |

Primary source references:

- [Waveshare V2 hardware/BSP documentation](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-1.8): V1 uses SH8601/FT3168; V2 uses CO5300/CST820, with QSPI display and I2C touch.
- [Waveshare source repository](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.8).
- [Espressif component registry: BSP 2.0.3](https://components.espressif.com/components/waveshare/esp32_s3_touch_amoled_1_8/versions/2.0.3/readme).
- [ESP-IDF 5.5 documentation](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32s3/).

The schematic and BSP are source references for the composition. They are not
an observation of the unavailable unit in this checkout.

The V2 adapter owns the display bring-up boundary. It initializes the BSP
TCA9554 handle, drives expander pins 0, 1 and 2 low, waits 20 ms, and releases
them high before the BSP CO5300 QSPI constructor runs. It then registers that
panel with the generic `lvgl_port_add_disp()` path and binds the explicit
CST816S-compatible touch driver to the same LVGL display. The RGB helper in
the BSP is not used by this target.

## Identity and runtime gate

The V2 adapter probes the BSP-owned I2C bus before display startup. It does
not construct a panel or touch driver and does not write controller registers
during the probe.

| FT-family `0x38` | CST-compatible `0x15` | V2 result |
|---|---|---|
| no ACK | ACK | `matched` (`v2-cst-ack`) |
| ACK | no ACK or probe error | `mismatch` (`v1-ft-ack`) |
| ACK | ACK | `unknown` (`ambiguous-dual-ack`) |
| no ACK | no ACK, error, or other unresolved result | `unknown` |

Only `matched` reaches V2 display startup, runtime startup and ready
transport. Mismatch and unknown states stay in rejected diagnostic mode.
This policy is host-tested by `tests/firmware-target-matrix.test.mjs` and is
not physical identity proof.

## Evidence boundary

| Evidence class | Current state |
|---|---|
| Host source/registry/identity tests | Implemented and run by the repository test gates |
| Firmware-build evidence | V1 and V2 clean pinned-container builds are required validation outputs; each emits a target descriptor and exact lock |
| Physical UART/display/touch evidence | **NOT RUN**; no unit or UART is available |
| Recovery/security/eFuse evidence | **NOT RUN**; no recovery authorization or per-unit custody is available |
| Stock V2 provisioning | **BLOCKED** pending Plan 006 and the live partition/recovery gates |

Do not flash this target directly. Do not call the build descriptor a display,
touch, reset, or recovery result. The V1 target and its BSP pin remain
unchanged.
