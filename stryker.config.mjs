/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "command",
  commandRunner: {
    // The strict build before Stryker creates the public declaration snapshot.
    // Emit only instrumented JavaScript here: instrumentation can widen public
    // literal types, which is not a consumer API mutation. Per-mutant runs use
    // direct, injected lifecycle seams; full coverage and installed-consumer
    // contracts remain mandatory before/after the campaign, not per mutant.
    command: "export TSX_LVGL_MUTATION_BUILD=1 TSX_LVGL_VALIDATION_GIT_SHA=\"$(git rev-parse HEAD)\" TSX_LVGL_VALIDATION_GIT_STATE=clean; node scripts/build-mutation-output.mjs && npm run test:mutation",
  },
  // `npm run mutation` runs the strict build before Stryker. The sandbox keeps
  // those baseline declarations and only installs its isolated dependencies.
  buildCommand: "npm ci --ignore-scripts --no-audit --no-fund --engine-strict=false",
  inPlace: false,
  symlinkNodeModules: false,
  // Every shipped TypeScript module is mutation-tested. Consumer lifecycle,
  // CLI, packaging and provenance tests run for every mutant too, because the
  // SDK is only supported through that installed-package boundary.
  mutate: [
    "packages/core/src/**/*.ts",
    "packages/sensors/src/**/*.ts",
    "packages/runtime/src/**/*.ts",
    "packages/bundler/src/**/*.ts",
    "packages/device/src/**/*.ts",
    "packages/sdk/src/**/*.ts",
  ],
  // The ESP-IDF probe is validated by its own firmware gate. Its generated
  // managed_components tree is not part of the host mutation project.
  ignorePatterns: [
    "examples/esp-idf/*/build/**",
    "examples/esp-idf/*/managed_components/**",
  ],
  checkers: [],
  // Mutations can intentionally produce transient TypeScript-invalid types;
  // the normal npm build remains the strict type gate. The mutation runner
  // emits JavaScript with noCheck so every executable mutant reaches tests.
  disableTypeChecks: true,
  tsconfigFile: "tsconfig.json",
  coverageAnalysis: "off",
  reporters: ["clear-text", "html", "json", "progress"],
  thresholds: {
    high: 100,
    low: 100,
    // A surviving or timed-out mutant lowers the score and must fail CI.
    break: 100,
  },
  timeoutMS: 5000,
  // A single mutation worker keeps TypeScript incremental diagnostics stable
  // across clean runs; the extra wall time is preferable to drifting evidence.
  concurrency: 1,
  cleanTempDir: true,
};

export default config;
