# ESP-IDF V1 integration

This is the integration target for the first Waveshare hardware revision:
ESP32-S3 with the SH8601 display and FT3168 touch. The application uses
Waveshare BSP `1.1.4`, generates `ui.c` from the same `examples/counter.tsx`
entry used by the SDL simulator, and registers that exact file in the `main`
component.

The dependency is LVGL `9.5.0` and the repository development image pins
ESP-IDF `5.5.5`. Run the build through the pinned container:

```bash
./tools/dev esp-idf-v1
```

The CMake custom command dependency-tracks the source entry, compiler, emitter,
compatibility module, and lockfile, then regenerates before the firmware target
builds. The recovery manifest remains a hard stop: never flash from this
workflow. A successful pinned ESP-IDF build proves software compilation and BSP
integration only; it does not prove physical boot, display pixels, touch input,
timing, power, or V1 board behavior. Record the standard ESP-IDF size report
with the exact commit and container identity.
