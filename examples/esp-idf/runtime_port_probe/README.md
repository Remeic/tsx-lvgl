# Moved V1 target

The V1 firmware composition root moved to
`examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1` in Plan 003.

Use the repository target commands:

```bash
npm run board:build -- --target waveshare-touch-amoled-1.8-v1
npm run board:install -- --target waveshare-touch-amoled-1.8-v1 --app pomodoro
```

The shared runtime is `examples/esp-idf/components/tsx_runtime_probe`.
This directory is retained as a navigation note only; it is not an ESP-IDF
project and contains no runtime implementation.
