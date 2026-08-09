import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

export interface PackageManagerSelection {
  readonly name: PackageManagerName;
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export interface InstallInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

type Environment = Readonly<Record<string, string | undefined>>;

const PACKAGE_MANAGER_NAMES: readonly PackageManagerName[] = ["npm", "pnpm", "yarn", "bun"];

function managerFromToken(value: string): PackageManagerName | undefined {
  const normalized = value.trim().toLowerCase();
  const firstToken = normalized.split(/\s/)[0]!;
  const candidates = [firstToken.split("/")[0]!, basename(normalized)];
  for (const name of PACKAGE_MANAGER_NAMES) {
    if (candidates.some((candidate) => candidate === name || candidate.startsWith(`${name}-`) || candidate.startsWith(`${name}.`))) {
      return name;
    }
  }
  return undefined;
}

function managerFromOptionalToken(value: string | undefined): PackageManagerName | undefined {
  return value === undefined ? undefined : managerFromToken(value);
}

function managerFromPackageField(value: unknown): PackageManagerName | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliError(DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED, "packageManager must name npm, pnpm, yarn or bun");
  }
  const name = value.split("@", 1)[0]!;
  const manager = managerFromToken(name);
  if (manager === undefined) {
    throw new CliError(DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED, `unsupported package manager: ${value}`);
  }
  if (manager === "yarn" && yarnMajorFromPackageField(value) !== undefined && yarnMajorFromPackageField(value)! >= 2) {
    throw unsupportedYarn();
  }
  return manager;
}

function yarnMajorFromPackageField(value: string): number | undefined {
  const match = /^yarn@(\d+)(?:\.|$)/i.exec(value.trim());
  return match === null ? undefined : Number.parseInt(match[1]!, 10);
}

function yarnMajorFromToken(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /(?:^|\s)yarn\/(\d+)(?:\.|\s|$)/i.exec(value.trim());
  return match === null ? undefined : Number.parseInt(match[1]!, 10);
}

function unsupportedYarn(): CliError {
  return new CliError(
    DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED,
    "Yarn Berry (v2+) is not supported; use Yarn Classic (v1) or configure node_modules linking",
  );
}

function assertSupportedYarn(
  root: string,
  manager: PackageManagerName,
  ...tokens: readonly (string | undefined)[]
): void {
  if (manager !== "yarn") return;
  if (tokens.some((token) => yarnMajorFromToken(token) !== undefined && yarnMajorFromToken(token)! >= 2)) {
    throw unsupportedYarn();
  }
  if (existsSync(join(root, ".yarnrc.yml"))) throw unsupportedYarn();
}

function commandFor(name: PackageManagerName, environment: Environment): PackageManagerSelection {
  const execPath = environment.npm_execpath;
  if (execPath === undefined) return { name, command: name, prefixArgs: [] };
  if (managerFromToken(execPath) !== name) return { name, command: name, prefixArgs: [] };
  if (name === "bun") return { name, command: execPath, prefixArgs: [] };
  return { name, command: process.execPath, prefixArgs: [execPath] };
}

export function resolvePackageManager(
  root: string,
  packageJson: Readonly<Record<string, unknown>>,
  environment: Environment = process.env,
): PackageManagerSelection {
  const configured = managerFromPackageField(packageJson.packageManager);
  if (configured !== undefined) {
    assertSupportedYarn(root, configured, environment.npm_config_user_agent, environment.npm_execpath);
    return commandFor(configured, environment);
  }

  const invoked = managerFromOptionalToken(environment.npm_config_user_agent)
    ?? managerFromOptionalToken(environment.npm_execpath);
  if (invoked !== undefined) {
    assertSupportedYarn(root, invoked, environment.npm_config_user_agent, environment.npm_execpath);
    return commandFor(invoked, environment);
  }

  const lockFiles: Array<{ readonly name: PackageManagerName; readonly file: string }> = [
    { name: "pnpm", file: "pnpm-lock.yaml" },
    { name: "yarn", file: "yarn.lock" },
    { name: "bun", file: "bun.lock" },
    { name: "bun", file: "bun.lockb" },
    { name: "npm", file: "package-lock.json" },
  ];
  const detected = lockFiles
    .filter(({ file }) => existsSync(join(root, file)))
    .map(({ name }) => name)
    .filter((name, index, names) => names.indexOf(name) === index);
  if (detected.length > 1) {
    throw new CliError(
      DIAGNOSTIC_CODES.PACKAGE_MANAGER_AMBIGUOUS,
      `multiple package-manager lockfiles found: ${detected.join(", ")}`,
    );
  }
  assertSupportedYarn(root, detected[0] ?? "npm");
  return commandFor(detected[0] ?? "npm", environment);
}

export function buildInstallInvocation(
  selection: PackageManagerSelection,
  hasNpmLock: boolean,
): InstallInvocation {
  const args = [...selection.prefixArgs, "install", "--ignore-scripts"];
  switch (selection.name) {
    case "npm":
      args.push("--no-audit", "--no-fund", "--offline");
      if (hasNpmLock) args.push("--package-lock=false");
      break;
    case "pnpm":
      args.push("--offline", "--no-frozen-lockfile");
      break;
    case "yarn":
    case "bun":
      break;
  }
  return { command: selection.command, args };
}
