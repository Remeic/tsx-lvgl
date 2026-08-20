# Waveshare V2 build-only target

The V2 target is `waveshare-touch-amoled-1.8-v2` with canonical firmware ID
`waveshare.esp32s3.touch-amoled-1.8.v2`. Its support state is
`experimental-build-only`. SDK consumer selection rejects it; the build
registry and CI firmware matrix list it as a separate target.

Use the [target-local guide](../../examples/esp-idf/targets/waveshare_touch_amoled_1_8_v2/README.md)
for the exact BSP/component lock, adapter identity policy and artifact paths.

Evidence boundary for this checkout:

- Host registry, source-boundary, transport cross-ID and C identity tests are
  testable evidence.
- A clean ESP-IDF build is firmware-build evidence only.
- Physical UART, display, touch, reset and repeated-reload evidence is **NOT
  RUN** because no unit is available.
- Recovery, security/eFuse and provisioning evidence is **NOT RUN** because no
  recovery authorization or per-unit custody is available.
- First-time stock V2 writes remain **BLOCKED** by Plan 006 and the live
  partition gate.

The V1 target remains the supported target and keeps its existing BSP pin and
behavior. There is no universal runtime board switch.
