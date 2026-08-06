import { createMutationConfig } from "./stryker.config.mjs";

/**
 * Keep the React source-entry quality gate independent from the legacy tree.
 * The compiler-private emitter is mutated here because compileProject is its
 * only public seam; no native IR object is constructed by tests. Its 80% gate
 * and bounded worker count are intentionally separate from legacy policy.
 */
const config = createMutationConfig(
  [
    "packages/compiler/src/**/*.ts",
    "packages/react/src/**/*.ts",
  ],
  "reports/mutation/mvp",
);

export default {
  ...config,
  thresholds: {
    high: 80,
    low: 70,
    break: 80,
  },
  concurrency: 4,
};
