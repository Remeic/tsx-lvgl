import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";

import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";
import type { FrameworkLock } from "./framework-lock.js";
import { SDK_PACKAGE_NAME } from "./metadata.js";
import { buildInstallInvocation, resolvePackageManager } from "./package-manager.js";

export interface InstallExecutor {
  install(root: string, lock: FrameworkLock, artifactPath: string, verifyInstalled: () => void): Promise<void>;
}

/** Injectable package-manager boundary used by the project lifecycle. */
export type PackageManagerInstaller = (root: string, artifactPath: string) => Promise<void>;

/** Narrow boundary for the package manager side effect of a project update. */
export function createInstallExecutor(
  installPackageManager: PackageManagerInstaller = runPackageManagerInstall,
): InstallExecutor {
  return {
    async install(root, lock, artifactPath, verifyInstalled) {
      writeSdkDependency(root, lock);
      await installPackageManager(root, artifactPath);
      verifyInstalled();
    },
  };
}

export const DEFAULT_INSTALL_EXECUTOR = createInstallExecutor();

function writeSdkDependency(root: string, lock: FrameworkLock): void {
  const packagePath = join(root, "package.json");
  const value = readJson(packagePath, DIAGNOSTIC_CODES.PACKAGE_INVALID);
  const dependencies = isRecord(value.dependencies) ? { ...value.dependencies } : {};
  dependencies[SDK_PACKAGE_NAME] = `file:${lock.artifact.file}`;
  value.dependencies = dependencies;
  writeFileSync(packagePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileSync(join(root, ".tsx-lvgl", "framework.lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

async function runPackageManagerInstall(root: string, artifactPath: string): Promise<void> {
  const packageJson = readJson(join(root, "package.json"), DIAGNOSTIC_CODES.PACKAGE_INVALID);
  const packageManager = await resolvePackageManager(root, packageJson);
  const packageLockPath = join(root, "package-lock.json");
  const hasPackageLock = existsSync(packageLockPath);
  const bunCacheRoot = packageManager.name === "bun"
    ? mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tsx-lvgl-bun-cache-"))
    : undefined;
  const invocation = buildInstallInvocation(packageManager, hasPackageLock, bunCacheRoot);
  const result = (() => {
    try {
      return spawnSync(invocation.command, invocation.args, { cwd: root, encoding: "utf8", stdio: "pipe" });
    } finally {
      if (bunCacheRoot !== undefined) rmSync(bunCacheRoot, { recursive: true, force: true });
    }
  })();
  const errorCode = result.error !== undefined && "code" in result.error ? result.error.code : undefined;
  if (errorCode === "ENOENT") {
    throw new CliError(DIAGNOSTIC_CODES.PACKAGE_MANAGER_NOT_FOUND, `package manager is not installed: ${packageManager.name}`);
  }
  if (result.status !== 0) {
    throw new CliError(DIAGNOSTIC_CODES.INSTALL_FAILED, `${packageManager.name} could not install the locked local SDK artifact`);
  }
  if (packageManager.name === "npm" && hasPackageLock) synchronizePackageLock(packageLockPath, root, artifactPath);
}

/** Normalize npm lockfile records after a successful local-artifact install. */
export function synchronizePackageLock(packageLockPath: string, root: string, artifactPath: string): void {
  const packageLock = readJson(packageLockPath, DIAGNOSTIC_CODES.INSTALL_FAILED);
  const relativeArtifact = relative(root, artifactPath).split(sep).join("/");
  const integrity = `sha512-${createHash("sha512").update(readFileSync(artifactPath)).digest("base64")}`;
  const packages = isRecord(packageLock.packages) ? packageLock.packages : undefined;
  if (packages !== undefined) {
    const rootPackage = isRecord(packages[""]) ? packages[""] : undefined;
    const sdkPackage = isRecord(packages[`node_modules/${SDK_PACKAGE_NAME}`]) ? packages[`node_modules/${SDK_PACKAGE_NAME}`] : undefined;
    if (rootPackage === undefined || sdkPackage === undefined) {
      throw new CliError(DIAGNOSTIC_CODES.INSTALL_FAILED, "package-lock.json has no installed SDK entry");
    }
    const rootDependencies = isRecord(rootPackage.dependencies) ? { ...rootPackage.dependencies } : {};
    rootDependencies[SDK_PACKAGE_NAME] = `file:${relativeArtifact}`;
    rootPackage.dependencies = rootDependencies;
    sdkPackage.resolved = `file:${relativeArtifact}`;
    sdkPackage.integrity = integrity;
  } else {
    const dependencies = isRecord(packageLock.dependencies) ? packageLock.dependencies : {};
    const sdkPackage = isRecord(dependencies[SDK_PACKAGE_NAME]) ? dependencies[SDK_PACKAGE_NAME] : undefined;
    if (sdkPackage === undefined) {
      throw new CliError(DIAGNOSTIC_CODES.INSTALL_FAILED, "package-lock.json has no installed SDK entry");
    }
    sdkPackage.resolved = `file:${relativeArtifact}`;
    sdkPackage.integrity = integrity;
  }
  writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`, "utf8");
}

function readJson(filePath: string, code: typeof DIAGNOSTIC_CODES[keyof typeof DIAGNOSTIC_CODES]): Record<string, any> {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, any>;
  } catch {
    throw new CliError(code, "cannot read package-lock.json");
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
