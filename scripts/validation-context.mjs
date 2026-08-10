import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_STATES = new Set(["clean", "dirty"]);
const GIT_SOURCES = new Set(["git", "environment"]);

export const VALIDATION_GIT_SHA_ENV = "TSX_LVGL_VALIDATION_GIT_SHA";
export const VALIDATION_GIT_STATE_ENV = "TSX_LVGL_VALIDATION_GIT_STATE";

function requiredValue(label, value) {
  if (typeof value !== "string") {
    throw new Error(`${label} is required`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

export function createValidationContext({
  gitSha,
  gitState,
  gitSource,
  nodeVersion,
  npmVersion,
}) {
  const normalizedSha = requiredValue("Git SHA", gitSha);
  if (!FULL_GIT_SHA_PATTERN.test(normalizedSha)) {
    throw new Error("Git SHA must be a full hexadecimal object ID");
  }
  const normalizedState = requiredValue("Git state", gitState);
  if (!GIT_STATES.has(normalizedState)) {
    throw new Error("Git state must be clean or dirty");
  }
  const normalizedSource = requiredValue("Git source", gitSource);
  if (!GIT_SOURCES.has(normalizedSource)) {
    throw new Error("Git source must be git or environment");
  }

  return {
    gitSha: normalizedSha,
    gitState: normalizedState,
    gitSource: normalizedSource,
    nodeVersion: requiredValue("Node version", nodeVersion),
    npmVersion: requiredValue("npm version", npmVersion),
  };
}

function isGitMetadataUnavailable(error) {
  const details = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
  return /not a git repository/i.test(details);
}

function contextFromEnvironment(environment) {
  return {
    gitSha: requiredValue(
      VALIDATION_GIT_SHA_ENV,
      environment[VALIDATION_GIT_SHA_ENV],
    ),
    gitState: requiredValue(
      VALIDATION_GIT_STATE_ENV,
      environment[VALIDATION_GIT_STATE_ENV],
    ),
    gitSource: "environment",
  };
}

async function collectGitContext({ cwd, run, environment }) {
  try {
    const [{ stdout: gitSha }, { stdout: gitStatus }] = await Promise.all([
      run("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }),
      run("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }),
    ]);
    return {
      gitSha,
      gitState: gitStatus.trim() ? "dirty" : "clean",
      gitSource: "git",
    };
  } catch (error) {
    if (!isGitMetadataUnavailable(error)) {
      throw error;
    }
    return contextFromEnvironment(environment);
  }
}

export async function collectValidationContext({
  cwd = process.cwd(),
  run = execFile,
  environment = process.env,
} = {}) {
  const [gitContext, { stdout: npmVersion }] = await Promise.all([
    collectGitContext({ cwd, run, environment }),
    run("npm", ["--version"], { cwd, encoding: "utf8" }),
  ]);

  return createValidationContext({
    ...gitContext,
    nodeVersion: process.version,
    npmVersion,
  });
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const context = await collectValidationContext();
  process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
}
