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
  return manager;
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
  if (configured !== undefined) return commandFor(configured, environment);

  const invoked = managerFromOptionalToken(environment.npm_config_user_agent)
    ?? managerFromOptionalToken(environment.npm_execpath);
  if (invoked !== undefined) return commandFor(invoked, environment);

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
  }
  return { command: selection.command, args };
}
