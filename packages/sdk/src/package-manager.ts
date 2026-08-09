import { existsSync } from "node:fs";
import { join } from "node:path";

import type { DetectResult, DetectStrategy } from "package-manager-detector";
import { resolveCommand } from "package-manager-detector/commands";
import { LOCKS } from "package-manager-detector/constants";
import { detect, getUserAgent } from "package-manager-detector/detect";

import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";
type SupportedAgent = "npm" | "pnpm" | "pnpm@6" | "yarn" | "bun";

export interface PackageManagerSelection {
  readonly name: PackageManagerName;
  readonly agent: SupportedAgent;
}

export interface PackageManagerDetectionContext {
  readonly userAgent?: string | null;
}

export interface InstallInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

const PACKAGE_MANAGER_NAMES: readonly PackageManagerName[] = ["npm", "pnpm", "yarn", "bun"];

export async function resolvePackageManager(
  root: string,
  packageJson: Readonly<Record<string, unknown>>,
  context: PackageManagerDetectionContext = {},
): Promise<PackageManagerSelection> {
  const configuredValue = packageJson.packageManager;
  if (configuredValue !== undefined) {
    if (typeof configuredValue !== "string" || configuredValue.trim().length === 0) {
      throw new CliError(DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED, "packageManager must name npm, pnpm, yarn or bun");
    }
    const configured = await detectAtRoot(root, packageJson, ["packageManager-field"]);
    if (configured.result === null) {
      throw new CliError(
        DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED,
        `unsupported package manager: ${configured.unknown ?? configuredValue}`,
      );
    }
    return toSupportedSelection(root, configured.result, configuredValue);
  }

  const invoked = context.userAgent === undefined ? getUserAgent() : context.userAgent;
  if (invoked !== null) {
    return toSupportedSelection(root, { name: invoked as DetectResult["name"], agent: invoked as DetectResult["agent"] }, invoked);
  }

  const lockManagers = detectLockfileManagers(root);
  if (lockManagers.length > 1) {
    throw new CliError(
      DIAGNOSTIC_CODES.PACKAGE_MANAGER_AMBIGUOUS,
      `multiple package-manager lockfiles found: ${lockManagers.join(", ")}`,
    );
  }
  if (lockManagers.length === 1) {
    const detected = await detectAtRoot(root, packageJson, ["lockfile"]);
    if (detected.result !== null) return toSupportedSelection(root, detected.result, lockManagers[0]!);
    const name = lockManagers[0]!;
    return { name, agent: name };
  }

  return { name: "npm", agent: "npm" };
}

export function buildInstallInvocation(
  selection: PackageManagerSelection,
  hasNpmLock: boolean,
  bunCacheDirectory?: string,
): InstallInvocation {
  const flags = ["--ignore-scripts"];
  switch (selection.name) {
    case "npm":
      flags.push("--no-audit", "--no-fund", "--offline");
      if (hasNpmLock) flags.push("--package-lock=false");
      break;
    case "pnpm":
      flags.push("--offline", "--no-frozen-lockfile");
      break;
    case "yarn":
      break;
    case "bun":
      if (bunCacheDirectory !== undefined) flags.push("--cache-dir", bunCacheDirectory);
      break;
  }
  const invocation = resolveCommand(selection.agent, "install", flags);
  if (invocation === null) {
    throw new CliError(
      DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED,
      `package manager cannot install dependencies: ${selection.name}`,
    );
  }
  return invocation;
}

async function detectAtRoot(
  root: string,
  packageJson: Readonly<Record<string, unknown>>,
  strategies: readonly DetectStrategy[],
): Promise<{ readonly result: DetectResult | null; readonly unknown?: string }> {
  let unknown: string | undefined;
  const result = await detect({
    cwd: root,
    stopDir: root,
    strategies: [...strategies],
    packageJsonParser: () => packageJson,
    onUnknown: (value) => {
      unknown = value;
      return null;
    },
  });
  return { result, ...(unknown === undefined ? {} : { unknown }) };
}

function detectLockfileManagers(root: string): readonly PackageManagerName[] {
  return PACKAGE_MANAGER_NAMES.filter((name) =>
    Object.entries(LOCKS).some(([file, manager]) => manager === name && existsSync(join(root, file))),
  );
}

function toSupportedSelection(
  root: string,
  result: DetectResult,
  source: string,
): PackageManagerSelection {
  if (!isSupportedName(result.name)) {
    throw new CliError(DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED, `unsupported package manager: ${source}`);
  }
  if (result.agent === "yarn@berry" || (result.name === "yarn" && existsSync(join(root, ".yarnrc.yml")))) {
    throw new CliError(
      DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED,
      "Yarn Berry (v2+) is not supported; use Yarn Classic (v1), npm, pnpm or Bun",
    );
  }
  if (!isSupportedAgent(result.agent)) {
    throw new CliError(DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED, `unsupported package manager: ${source}`);
  }
  return { name: result.name, agent: result.agent };
}

function isSupportedName(name: string): name is PackageManagerName {
  return PACKAGE_MANAGER_NAMES.some((candidate) => candidate === name);
}

function isSupportedAgent(agent: string): agent is SupportedAgent {
  return agent === "npm" || agent === "pnpm" || agent === "pnpm@6" || agent === "yarn" || agent === "bun";
}
