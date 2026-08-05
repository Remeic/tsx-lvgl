/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const sharedConfig = {
  testRunner: "command",
  commandRunner: {
    command: "npm test",
  },
  // Install workspace links inside the sandbox before building. This keeps
  // mutation runs isolated from the checkout while preserving package exports.
  buildCommand: "npm ci --ignore-scripts --no-audit --no-fund && npm run build",
  inPlace: false,
  symlinkNodeModules: false,
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  coverageAnalysis: "off",
  reporters: ["clear-text", "html", "json", "progress"],
  // The compiler mutation set is intentionally explicit. Keep generated
  // ESP-IDF/LVGL sources out of Stryker's project reader so ignored vendor
  // HTML/C files do not create parser warnings or unstable scan time.
  ignorePatterns: [
    "build/**",
    "apps/**/build/**",
    "managed_components/**",
    "apps/**/managed_components/**",
  ],
  thresholds: {
    // Keep the pre-existing quality gate. The source-entry parser and emitter
    // need meaningful behavior/diagnostic coverage rather than a relaxed floor.
    high: 80,
    low: 70,
    break: 80,
  },
  timeoutMS: 5000,
  // Keep the worker count bounded so mutation runs remain reproducible without
  // turning the full source-entry suite into an unbounded process fan-out.
  concurrency: 4,
  cleanTempDir: true,
};

export function createMutationConfig(mutate, reportDirectory) {
  return {
    ...sharedConfig,
    mutate,
    htmlReporter: { fileName: `${reportDirectory}/mutation.html` },
    jsonReporter: { fileName: `${reportDirectory}/mutation.json` },
  };
}

const config = createMutationConfig(
  [
    "packages/core/src/**/*.ts",
    "packages/lvgl-emitter/src/**/*.ts",
  ],
  "reports/mutation/legacy",
);

export default config;
