import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MUTATION_DRY_RUN_BUDGET_MS = 10_000;

export function assertMutationDryRunBudget(elapsedMs, budgetMs = MUTATION_DRY_RUN_BUDGET_MS) {
  if (elapsedMs > budgetMs) {
    throw new Error(`mutation dry run exceeded ${budgetMs}ms (${elapsedMs}ms)`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const startedAt = performance.now();
  run(npm, ["run", "test:prepare"]);
  run(npm, ["exec", "--", "stryker", "run", "--dryRunOnly"]);
  const elapsedMs = Math.round(performance.now() - startedAt);
  assertMutationDryRunBudget(elapsedMs);
  console.log(`Mutation dry run completed in ${elapsedMs}ms (budget ${MUTATION_DRY_RUN_BUDGET_MS}ms).`);
}
