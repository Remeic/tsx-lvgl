import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";
import { SDK_PACKAGE_NAME } from "./metadata.js";

export interface SourcePackResult {
  readonly artifactPath: string;
  readonly packageName: typeof SDK_PACKAGE_NAME;
  readonly version: string;
  readonly sourceSha: string;
  readonly sourceDirty: boolean;
  readonly sha256: string;
  readonly byteLength: number;
}

/** Narrow seam for machine-local source discovery and external SDK packaging. */
export interface SourcePackAdapter {
  resolveSource(explicitSource?: string): string;
  createOutputDirectory(): string;
  pack(sourceRoot: string, outputRoot: string): SourcePackResult;
  removeOutputDirectory(outputRoot: string): void;
}

export const DEFAULT_SOURCE_PACK_ADAPTER: SourcePackAdapter = {
  resolveSource(explicitSource?: string): string {
    const configured = explicitSource ?? process.env.TSX_LVGL_SOURCE ?? readMachineSourceConfig();
    if (configured === undefined || configured.length === 0) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED, "set TSX_LVGL_SOURCE or configure ~/.config/tsx-lvgl/config.json");
    }
    const sourceRoot = resolve(configured);
    if (!existsSync(join(sourceRoot, "package.json")) || !existsSync(join(sourceRoot, "scripts", "pack-sdk.mjs"))) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED, "configured framework source is not a TSX-LVGL checkout");
    }
    return sourceRoot;
  },
  createOutputDirectory: () => mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tsx-lvgl-update-")),
  pack(sourceRoot, outputRoot): SourcePackResult {
    const packed = spawnSync(process.execPath, [join(sourceRoot, "scripts", "pack-sdk.mjs"), "--out", outputRoot, "--json"], {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (packed.status !== 0) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_PACK_FAILED, "framework source SDK packaging failed");
    }
    return parseSourcePackResult(packed.stdout);
  },
  removeOutputDirectory: (outputRoot) => rmSync(outputRoot, { recursive: true, force: true }),
};

function readMachineSourceConfig(): string | undefined {
  const configPath = process.env.TSX_LVGL_CONFIG
    ?? join(process.env.HOME ?? "/tmp", ".config", "tsx-lvgl", "config.json");
  if (!existsSync(configPath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return typeof value.sourcePath === "string" ? value.sourcePath : undefined;
  } catch {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED, "cannot read config.json");
  }
}

export function parseSourcePackResult(stdout: string): SourcePackResult {
  const line = stdout.trim().split(/\r?\n/).at(-1) as string;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PACK_FAILED, "framework source returned malformed packaging metadata");
  }
  if (
    value.packageName !== SDK_PACKAGE_NAME
    || typeof value.artifactPath !== "string"
    || typeof value.version !== "string"
    || typeof value.sourceSha !== "string"
    || typeof value.sourceDirty !== "boolean"
    || typeof value.sha256 !== "string"
    || typeof value.byteLength !== "number"
  ) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PACK_FAILED, "framework source returned malformed packaging metadata");
  }
  return {
    artifactPath: value.artifactPath,
    packageName: SDK_PACKAGE_NAME,
    version: value.version,
    sourceSha: value.sourceSha,
    sourceDirty: value.sourceDirty,
    sha256: value.sha256,
    byteLength: value.byteLength,
  };
}
