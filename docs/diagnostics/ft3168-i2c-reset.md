# FT3168/I2C warm-reset diagnosis

Status: open hardware gate; no local UART reproduction was available in this
checkout. This note records the diagnosis boundary and the next falsifiable
experiment. It is not a board-ready result.

## Observed symptom

The handoff reports that some software resets produce a transient FT3168/I2C
initialization failure, followed by an automatic reboot and a successful boot
of a physical runtime-port probe on the ESP32-S3 board (not committed in this
change). QuickJS-NG engine, JavaScript, LVGL, sensor, timer and touch
checkpoints pass after the successful boot. Therefore the symptom is
currently correlated with board/BSP reset sequencing, not with the JavaScript
engine.

## Source facts

- The pinned Waveshare BSP (vendored in the not-committed runtime-port probe)
  uses I2C GPIO14/15 and declares `BSP_LCD_TOUCH_RST` as `GPIO_NUM_NC` in
  `esp32_s3_touch_amoled_1_8.h`.
- `bsp_touch_new()` creates the FT5x06-compatible I2C panel IO immediately
  after `bsp_i2c_init()`; it does not provide a retry or bus-clear policy in
  the inspected BSP source.
- The Espressif FT5x06 driver only toggles a reset GPIO when the reset pin is
  not `GPIO_NUM_NC`. The configured board path therefore cannot prove that a
  software reset returned the touch controller to a known state.
- ESP-IDF documents that software restart does not reset most peripherals.
  The official I2C API provides bounded transaction errors and a bus reset
  mechanism. See the [ESP-IDF reset API](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/system/misc_system_api.html),
  [I2C API](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/peripherals/i2c.html)
  and [Waveshare BSP source](https://github.com/waveshareteam/Waveshare-ESP32-components/tree/c77caf968fa6b11f3b6a416c853c578d012a8cea/bsp/esp32_s3_touch_amoled_1_8).

## Ranked hypotheses

| Rank | Hypothesis | Prediction | Falsifier |
| --- | --- | --- | --- |
| 1 | Touch controller state survives warm reset because no reset GPIO is exposed. | A clean power cycle succeeds consistently while repeated software reset can fail. | Failure persists after a clean power cycle with identical power/transport conditions. |
| 2 | SDA/SCL is held or the new I2C master starts before the bus is recoverable. | A bounded bus-clear/reset and one retry before touch creation removes the first-boot failure. | Instrumented bus reset/retry leaves the failure rate unchanged. |
| 3 | Controller power/settle timing is marginal after software reset. | A delay-only change improves the failure rate without changing I2C operations. | Delay sweep has no effect while bus recovery does. |
| 4 | Board startup ordering races touch creation with display/LVGL ownership. | Serializing touch creation after the board owner task is ready changes the outcome. | A single serialized owner-task path still fails with the same signature. |

## Reproduction loop

The required loop is a guarded, logged sequence of at least 20 runs per
condition:

1. Capture a cold power-cycle baseline and the full UART boot sequence.
2. Run the same physical runtime-port probe through the guarded app-only
   workflow; never use
   direct `idf.py flash`.
3. Trigger one software reset, capture the first boot failure/success and any
   automatic reboot, then classify the exact I2C/FT3168 error.
4. Repeat with a clean power cycle, then repeat after one bounded diagnostic
   variable at a time: delay, bus reset/retry, or serialized ordering.
5. Require the runtime checkpoints after every successful boot and keep the
   reset/BSP result separate from QuickJS/LVGL evidence.

No physical run was started here because the user did not authorize flashing
and the recovery/identity gate is external to this checkout. Until this loop
exists, no retry or reset-sequencing fix should be presented as validated.
