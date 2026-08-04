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
  concurrency: 2,
  cleanTempDir: true,
};

export default config;
