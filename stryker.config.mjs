/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "command",
  commandRunner: {
    // Compile each mutant, then run the already-compiled suite. The public
    // test command cleans first, which would discard Stryker's sandbox output.
    command: "npx tsc -b --noCheck --pretty false && npm run test:compiled",
  },
  // Install workspace links inside the sandbox before building. This keeps
  // mutation runs isolated from the checkout while preserving package exports.
  buildCommand: "npm ci --ignore-scripts --no-audit --no-fund --engine-strict=false && npx tsc -b --noCheck --pretty false",
  inPlace: false,
  symlinkNodeModules: false,
  mutate: ["packages/*/src/**/*.ts"],
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
