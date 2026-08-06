# LVGL 9.5.0 SDL simulator

The simulator compiles the same `examples/counter.tsx` source and generated
`ui.c` used by the ESP-IDF application. CMake fetches LVGL `v9.5.0` with a
SHA-256-verified archive and links the SDL driver.

From the repository root:

```bash
npm run simulator:test
```

The test runs headlessly when `SDL_VIDEODRIVER=dummy` is set, sends one native
`LV_EVENT_CLICKED`, checks the generated state accessor (`0 -> 1`), and writes
`counter-before.ppm` and `counter-after.ppm` under `build/simulator/evidence`.
The screenshots prove the desktop LVGL artifact and native event path only;
they do not prove the Waveshare panel, touch controller, power sequencing, or
board revision.
