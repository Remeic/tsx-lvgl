import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
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

export const DEFAULT_ARTIFACT_STORE: ArtifactStore = {
  resolve: (root, lock) => resolveProjectArtifact(root, lock.artifact.file),
  verify(path, lock) {
    if (!existsSync(path)) {
      throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "framework artifact is missing");
    }
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
    const destination = resolveProjectArtifact(root, `.tsx-lvgl/artifacts/${artifactFile}`);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(artifactPath, destination);
    const bytes = readFileSync(destination);
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

function resolveProjectArtifact(root: string, file: string): string {
  validateArtifactReference(file);
  const artifactDirectory = resolve(root, ".tsx-lvgl", "artifacts");
  const destination = resolve(root, file);
  if (destination === artifactDirectory || !destination.startsWith(`${artifactDirectory}${sep}`)) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "framework artifact path must stay inside .tsx-lvgl/artifacts");
  }
  return destination;
}

function artifactFileName(version: string): string {
  if (validSemver(version) !== version) {
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH, "SDK artifact has invalid provenance");
  }
  const file = `tsx-lvgl-sdk-${version}.tgz`;
  if (basename(file) !== file) {
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH, "SDK artifact has invalid provenance");
  }
  return file;
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
