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
    "examples/**/build/**",
    "examples/**/managed_components/**",
  ],
  thresholds: {
    // Preserve origin/main's strict legacy gate. The MVP config overrides this
    // policy explicitly for the independent source-entry slice.
    high: 100,
    low: 100,
    break: 100,
  },
  timeoutMS: 5000,
  // Preserve origin/main's serial legacy run for reproducible resource use.
  // The MVP config overrides this with its independently bounded concurrency.
  concurrency: 1,
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
