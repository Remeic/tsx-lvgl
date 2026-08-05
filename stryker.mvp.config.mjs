import { createMutationConfig } from "./stryker.config.mjs";

/**
 * Keep the React source-entry quality gate independent from the legacy tree.
 * The compiler-private emitter is mutated here because compileProject is its
 * only public seam; no native IR object is constructed by tests.
 */
export default createMutationConfig(
  [
    "packages/compiler/src/**/*.ts",
    "packages/react/src/**/*.ts",
  ],
  "reports/mutation/mvp",
);
