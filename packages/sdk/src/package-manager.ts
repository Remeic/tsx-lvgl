import { existsSync } from "node:fs";
import { join } from "node:path";

import type { DetectResult } from "package-manager-detector";
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
    const configured = await detectConfiguredManager(root, packageJson);
    if (configured === null) {
      throw new CliError(
        DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED,
        `unsupported package manager: ${configuredValue}`,
      );
    }
    return toSupportedSelection(root, configured, configuredValue);
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
    const name = lockManagers[0]!;
    return toSupportedSelection(root, { name, agent: name }, name);
  }

  return { name: "npm", agent: "npm" };
}

export function buildInstallInvocation(
  selection: PackageManagerSelection,
  hasNpmLock: boolean,
  bunCacheDirectory?: string,
): InstallInvocation {
  const flags = ["--ignore-scripts"];
  if (selection.name === "npm") {
    flags.push("--no-audit", "--no-fund", "--offline");
    if (hasNpmLock) flags.push("--package-lock=false");
  } else if (selection.name === "pnpm") {
    flags.push("--offline", "--no-frozen-lockfile");
  } else if (selection.name === "bun" && bunCacheDirectory !== undefined) {
    flags.push("--cache-dir", bunCacheDirectory);
  }
  return resolveCommand(selection.agent, "install", flags)!;
}

async function detectConfiguredManager(
  root: string,
  packageJson: Readonly<Record<string, unknown>>,
): Promise<DetectResult | null> {
  return detect({
    cwd: root,
    stopDir: root,
    strategies: ["packageManager-field"],
    packageJsonParser: () => packageJson,
  });
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
  if (result.agent === "yarn@berry" || (result.agent === "yarn" && existsSync(join(root, ".yarnrc.yml")))) {
    throw new CliError(
      DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED,
      "Yarn Berry (v2+) is not supported; use Yarn Classic (v1), npm, pnpm or Bun",
    );
  }
  switch (result.agent) {
    case "npm":
      return { name: "npm", agent: "npm" };
    case "pnpm":
    case "pnpm@6":
      return { name: "pnpm", agent: result.agent };
    case "yarn":
      return { name: "yarn", agent: "yarn" };
    case "bun":
      return { name: "bun", agent: "bun" };
    default:
      throw new CliError(DIAGNOSTIC_CODES.PACKAGE_MANAGER_UNSUPPORTED, `unsupported package manager: ${source}`);
  }
}
