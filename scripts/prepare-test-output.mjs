import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_OUTPUT_DIRECTORY = "test-dist";

/**
 * Resolve the one generated test directory this repository is allowed to
 * remove. Supplying the repository root keeps cleanup testable in a sandbox.
 */
export function resolveTestOutputDirectory(
  repositoryRoot,
  outputDirectory = TEST_OUTPUT_DIRECTORY,
) {
  if (!isAbsolute(repositoryRoot)) {
    throw new Error("repository root must be absolute");
  }
  if (outputDirectory !== TEST_OUTPUT_DIRECTORY) {
    throw new Error(`test output directory must be ${TEST_OUTPUT_DIRECTORY}`);
  }

  return join(resolve(repositoryRoot), TEST_OUTPUT_DIRECTORY);
}

export async function prepareTestOutput({
  repositoryRoot,
  outputDirectory = TEST_OUTPUT_DIRECTORY,
  remove = rm,
}) {
  const testOutputDirectory = resolveTestOutputDirectory(
    repositoryRoot,
    outputDirectory,
  );
  await remove(testOutputDirectory, { recursive: true, force: true });
  return testOutputDirectory;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const repositoryRoot = resolve(dirname(scriptPath), "..");
  await prepareTestOutput({ repositoryRoot });
}
