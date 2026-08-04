/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "command",
  commandRunner: {
    command: "npm test",
  },
  // Install workspace links inside the sandbox before building. This keeps
  // mutation runs isolated from the checkout while preserving package exports.
  buildCommand: "npm ci --ignore-scripts --no-audit --no-fund && npm run build",
  inPlace: false,
  symlinkNodeModules: false,
  mutate: [
    "packages/core/src/**/*.ts",
    "packages/lvgl-emitter/src/**/*.ts",
    "packages/compiler/src/**/*.ts",
  ],
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  coverageAnalysis: "off",
  reporters: ["clear-text", "html", "json", "progress"],
  thresholds: {
    high: 80,
    low: 60,
    break: 80,
  },
  timeoutMS: 5000,
  // A single mutation worker keeps TypeScript incremental diagnostics stable
  // across clean runs; the extra wall time is preferable to drifting evidence.
  concurrency: 1,
  cleanTempDir: true,
};

export default config;
