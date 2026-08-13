import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { valid as validSemver } from "semver";

import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";
import type { FrameworkLock } from "./framework-lock.js";
import { LOCK_FORMAT_VERSION, SDK_PACKAGE_NAME } from "./metadata.js";
import type { SourcePackResult } from "./source-pack.js";

interface PackProvenance {
  readonly formatVersion: 1;
  readonly packageName: typeof SDK_PACKAGE_NAME;
  readonly version: string;
  readonly sourceSha: string;
  readonly sourceDirty: false;
}

/** Narrow persistence seam for project-local SDK artifacts and their provenance. */
export interface ArtifactStore {
  resolve(root: string, lock: FrameworkLock): string;
  verify(path: string, lock: FrameworkLock): void;
  install(root: string, artifactPath: string, metadata?: SourcePackResult): FrameworkLock;
}

export interface ArtifactStoreHooks {
  /** Test seam called after the private staged state is complete, before its
   * path-component-safe rename swaps it into the project. */
  beforeInstallSwap?(): void;
  afterFirstRename?(): void;
  beforeSecondRename?(stagePath: string): void;
  failSecondRename?(): void;
  afterSecondRename?(): void;
  beforeRecoveryMutation?(path: string): void;
}

export function createArtifactStore(hooks: ArtifactStoreHooks = {}): ArtifactStore {
  return {
  resolve: (root, lock) => resolveProjectArtifact(root, lock.artifact.file),
  verify(path, lock) {
    if (!existsSync(path)) {
      throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "framework artifact is missing");
    }
    assertArtifactFile(path);
    const bytes = readFileSync(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== lock.artifact.sha256 || statSync(path).size !== lock.artifact.byteLength) {
      throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH, "framework artifact digest or byte length does not match the lock");
    }
  },
  install(root, artifactPath, metadata) {
    if (!existsSync(artifactPath)) throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "SDK artifact does not exist");
    const provenance = metadata === undefined ? readPackProvenance(artifactPath) : {
      formatVersion: 1 as const,
      packageName: metadata.packageName,
      version: metadata.version,
      sourceSha: metadata.sourceSha,
      sourceDirty: false as const,
    };
    if (
      provenance.sourceDirty !== false
      || provenance.packageName !== SDK_PACKAGE_NAME
      || !/^[0-9a-f]{40}$/.test(provenance.sourceSha)
    ) {
      if (provenance.sourceDirty !== false) {
        throw new CliError(DIAGNOSTIC_CODES.SOURCE_DIRTY, "SDK artifact was packed from a dirty framework checkout");
      }
      throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH, "SDK artifact has invalid provenance");
    }
    const artifactFile = artifactFileName(provenance.version);
    const bytes = readFileSync(artifactPath);
    replaceProjectStateAtomically(root, artifactFile, bytes, hooks);
    return {
      formatVersion: LOCK_FORMAT_VERSION,
      package: SDK_PACKAGE_NAME,
      version: provenance.version,
      sourceSha: provenance.sourceSha,
      artifact: {
        file: `.tsx-lvgl/artifacts/${artifactFile}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      },
    };
  },
  };
}

export const DEFAULT_ARTIFACT_STORE = createArtifactStore();

/**
 * Finish the artifact-directory half of an interrupted install before any
 * command reads the framework lock. It keeps a completed second rename and
 * restores the old artifacts when only the first rename completed.
 */
export function recoverProjectArtifactState(root: string, hooks: ArtifactStoreHooks = {}): void {
  const projectRoot = resolve(root);
  const state = join(projectRoot, ".tsx-lvgl");
  if (!existsSync(state)) return;
  assertStateDirectory(state, projectRoot);
  const artifacts = join(state, "artifacts");
  const backup = join(state, ".artifacts-backup");
  recoverArtifactSwap(state, projectRoot, artifacts, backup, hooks);
  for (const entry of readdirSync(state)) {
    if (!entry.startsWith(".artifacts-stage-")) continue;
    const stage = join(state, entry);
    const details = lstatSync(stage);
    if (!details.isDirectory() || details.isSymbolicLink()) continue;
    hooks.beforeRecoveryMutation?.(stage);
    assertStateDirectory(state, projectRoot);
    const current = lstatSync(stage);
    if (current.isDirectory() && !current.isSymbolicLink()) rmSync(stage, { recursive: true, force: true });
  }
}

export function validateArtifactReference(file: string): void {
  const artifactPrefix = ".tsx-lvgl/artifacts/";
  if (
    isAbsolute(file)
    || file.includes("\\")
    || !file.startsWith(artifactPrefix)
    || posix.normalize(file) !== file
    || file.length === artifactPrefix.length
  ) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "framework artifact path must stay inside .tsx-lvgl/artifacts");
  }
}

function resolveProjectArtifact(root: string, file: string, createDirectory = false): string {
  validateArtifactReference(file);
  const projectRoot = resolve(root);
  const artifacts = projectArtifactDirectory(projectRoot, createDirectory);
  const destination = resolve(projectRoot, file);
  /* node:coverage disable */
  // Unreachable defense in depth: validateArtifactReference already rejects every path that could resolve outside the artifact directory.
  if (!isContained(projectRoot, destination) || !isContained(artifacts, destination)) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "framework artifact path must stay inside .tsx-lvgl/artifacts");
  }
  /* node:coverage enable */
  if (existsSync(destination)) assertArtifactFile(destination);
  return destination;
}

function projectArtifactDirectory(root: string, createDirectory: boolean): string {
  const canonicalRoot = canonicalDirectory(root);
  let current = root;
  for (const component of [".tsx-lvgl", "artifacts"]) {
    current = join(current, component);
    if (!existsSync(current)) {
      if (!createDirectory) return current;
      mkdirSync(current);
    }
    const details = lstatSync(current);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "framework artifact directory must not be a symlink");
    }
    const canonicalCurrent = canonicalDirectory(current);
    /* node:coverage disable */
    // TOCTOU guard: only reachable if the directory is swapped for a symlink between the lstat above and this realpath.
    if (!isContained(canonicalRoot, canonicalCurrent)) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "framework artifact directory escapes the project");
    }
    /* node:coverage enable */
  }
  return current;
}

function canonicalDirectory(path: string): string {
  try {
    if (!lstatSync(path).isDirectory()) throw new Error("not a directory");
    return realpathSync(path);
  } catch {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "project artifact directory is unavailable");
  }
}

function isContained(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function assertArtifactFile(path: string): void {
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "framework artifact must not be a symlink");
  }
}

function replaceProjectStateAtomically(root: string, artifactFile: string, bytes: Uint8Array, hooks: ArtifactStoreHooks): void {
  const projectRoot = resolve(root);
  const state = join(projectRoot, ".tsx-lvgl");
  if (existsSync(state)) {
    assertStateDirectory(state, projectRoot);
  }
  mkdirSync(state, { recursive: true });
  assertStateDirectory(state, projectRoot);
  const artifacts = join(state, "artifacts");
  const backup = join(state, ".artifacts-backup");
  recoverProjectArtifactState(projectRoot);
  assertStateDirectory(state, projectRoot);
  const stage = mkdtempSync(join(state, ".artifacts-stage-"));
  let movedPrevious = false;
  let interrupted = false;
  try {
    if (existsSync(artifacts)) copyAllowedArtifacts(artifacts, stage);
    writeFileSync(join(stage, artifactFile), bytes, { mode: 0o600 });
    hooks.beforeInstallSwap?.();
    assertStateDirectory(state, projectRoot);
    if (existsSync(artifacts)) {
      assertArtifactDirectory(artifacts);
      renameSync(artifacts, backup);
      movedPrevious = true;
    }
    hooks.afterFirstRename?.();
    hooks.beforeSecondRename?.(stage);
    hooks.failSecondRename?.();
    renameSync(stage, artifacts);
    hooks.afterSecondRename?.();
    try {
      assertArtifactDirectory(artifacts);
    } catch (error) {
      /* A substituted stage is a link at this point. Remove the link itself,
       * then restore the owned backup without ever traversing its target. */
      rmSync(artifacts, { recursive: true, force: true });
      if (movedPrevious && existsSync(backup)) renameSync(backup, artifacts);
      movedPrevious = false;
      throw error;
    }
    if (movedPrevious) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    interrupted = error instanceof Error && error.name === "InstallTransactionInterruptedError";
    throw error;
  } finally {
    if (!interrupted) {
      if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
      if (movedPrevious && existsSync(backup) && !existsSync(artifacts)) renameSync(backup, artifacts);
    }
  }
}

function assertStateDirectory(path: string, projectRoot: string): void {
  const details = lstatSync(path);
  if (
    !details.isDirectory()
    || details.isSymbolicLink()
    || !isContained(canonicalDirectory(projectRoot), canonicalDirectory(path))
  ) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "project state directory must not be a symlink");
  }
}

function recoverArtifactSwap(
  state: string,
  projectRoot: string,
  artifacts: string,
  backup: string,
  hooks: ArtifactStoreHooks,
): void {
  if (!existsSync(backup)) return;
  assertStateDirectory(state, projectRoot);
  assertArtifactDirectory(backup);
  if (!existsSync(artifacts)) {
    hooks.beforeRecoveryMutation?.(backup);
    assertStateDirectory(state, projectRoot);
    assertArtifactDirectory(backup);
    renameSync(backup, artifacts);
    return;
  }
  assertArtifactDirectory(artifacts);
  hooks.beforeRecoveryMutation?.(backup);
  assertStateDirectory(state, projectRoot);
  assertArtifactDirectory(backup);
  assertArtifactDirectory(artifacts);
  /* The staged directory contains all prior regular artifacts, so current is
   * complete after the second rename and the backup can be discarded. */
  rmSync(backup, { recursive: true, force: true });
}

function copyAllowedArtifacts(source: string, destination: string): void {
  assertArtifactDirectory(source);
  for (const entry of readdirSync(source)) {
    const path = join(source, entry);
    const details = lstatSync(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "framework artifact directory contains an unsupported entry");
    }
    writeFileSync(join(destination, entry), readFileSync(path), { mode: 0o600 });
  }
}

function assertArtifactDirectory(path: string): void {
  const details = lstatSync(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "framework artifact directory must not be a symlink");
  }
}

function artifactFileName(version: string): string {
  if (validSemver(version) !== version) {
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH, "SDK artifact has invalid provenance");
  }
  return `tsx-lvgl-sdk-${version}.tgz`;
}

function readPackProvenance(artifactPath: string): PackProvenance {
  let dirtyArtifact = false;
  try {
    const archive = gunzipSync(readFileSync(artifactPath));
    let offset = 0;
    while (offset + 512 <= archive.byteLength) {
      const name = archive.subarray(offset, offset + 100).toString("utf8").replace(/\0.*$/, "");
      if (name.length === 0) break;
      const sizeText = archive.subarray(offset + 124, offset + 136).toString("utf8").replace(/\0.*$/, "").trim();
      const size = Number.parseInt(sizeText || "0", 8);
      const dataStart = offset + 512;
      if (name === "package/provenance.json") {
        const value = JSON.parse(archive.subarray(dataStart, dataStart + size).toString("utf8")) as Record<string, unknown>;
        if (
          value.formatVersion !== 1
          || value.packageName !== SDK_PACKAGE_NAME
          || typeof value.version !== "string"
          || typeof value.sourceSha !== "string"
          || typeof value.sourceDirty !== "boolean"
        ) throw new Error("invalid provenance");
        if (value.sourceDirty === true) {
          dirtyArtifact = true;
          break;
        }
        return {
          formatVersion: 1,
          packageName: SDK_PACKAGE_NAME,
          version: value.version,
          sourceSha: value.sourceSha,
          sourceDirty: false,
        };
      }
      offset = dataStart + Math.ceil(size / 512) * 512;
    }
  } catch {
    // The stable external error below intentionally does not expose archive internals.
  }
  if (dirtyArtifact) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_DIRTY, "SDK artifact was packed from a dirty framework checkout");
  }
  throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH, "SDK artifact does not contain valid provenance");
}
