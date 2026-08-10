import { basename } from "node:path";

import { asCliError, CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";
import type { BuildResult, CheckResult, DevResult, FrameworkLock } from "./project.js";
import type { DoctorResult } from "./doctor.js";

export const USAGE = `Usage:
  tsx-lvgl create <directory> [--artifact <sdk.tgz>]
  tsx-lvgl sync [--json]
  tsx-lvgl update [--source <framework-checkout>] [--json]
  tsx-lvgl dev [--json]
  tsx-lvgl check [--json]
  tsx-lvgl build [--json]
  tsx-lvgl doctor [--json]

The app-facing interface is deliberately limited to these commands.\n`;

export interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly json: boolean;
  readonly artifact?: string;
  readonly source?: string;
}

export interface CliOperations {
  readonly createProject: (target: string, artifact?: string) => Promise<{ readonly root: string; readonly lock: FrameworkLock }>;
  readonly syncProject: (root: string) => Promise<{ readonly lock: FrameworkLock }>;
  readonly updateProject: (root: string, source?: string) => Promise<{ readonly lock: FrameworkLock }>;
  readonly checkProject: (root: string) => CheckResult;
  readonly buildProject: (root: string) => BuildResult;
  readonly devProject: (root: string) => Promise<DevResult>;
  readonly doctorProject: (root: string) => DoctorResult;
}

export interface CliWriter {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] ?? "help";
  const positional: string[] = [];
  let json = false;
  let artifact: string | undefined;
  let source: string | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "help", positional: [], json, ...(artifact === undefined ? {} : { artifact }), ...(source === undefined ? {} : { source }) };
    }
    if (argument === "--artifact") {
      artifact = argv[++index];
      if (artifact === undefined || artifact.startsWith("--")) throw usageError("--artifact requires a value");
      continue;
    }
    if (argument === "--source") {
      source = argv[++index];
      if (source === undefined || source.startsWith("--")) throw usageError("--source requires a value");
      continue;
    }
    if (argument.startsWith("--")) throw usageError(`unknown option: ${argument}`);
    positional.push(argument);
  }

  return { command, positional, json, ...(artifact === undefined ? {} : { artifact }), ...(source === undefined ? {} : { source }) };
}

/** Runs the command policy against injected project operations and output streams. */
export async function runCli(
  argv: readonly string[],
  cwd: string,
  operations: CliOperations,
  writer: CliWriter,
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    emitFailure(asCliError(error), argv.includes("--json"), writer);
    return 2;
  }

  if (parsed.command === "help") {
    writer.log(USAGE);
    return 0;
  }

  try {
    switch (parsed.command) {
      case "create": {
        const target = parsed.positional[0];
        if (target === undefined) throw usageError("create requires a target directory");
        const result = await operations.createProject(target, parsed.artifact);
        emitSuccess(parsed.json, "CREATE_OK", { project: basename(result.root), artifact: result.lock.artifact.file, sourceSha: result.lock.sourceSha }, writer);
        return 0;
      }
      case "sync": {
        const result = await operations.syncProject(cwd);
        emitSuccess(parsed.json, "SYNC_OK", { version: result.lock.version, sourceSha: result.lock.sourceSha }, writer);
        return 0;
      }
      case "update": {
        const result = await operations.updateProject(cwd, parsed.source);
        emitSuccess(parsed.json, "UPDATE_OK", { version: result.lock.version, sourceSha: result.lock.sourceSha }, writer);
        return 0;
      }
      case "check": {
        const result = operations.checkProject(cwd);
        emitSuccess(parsed.json, "CHECK_OK", { files: result.files }, writer);
        return 0;
      }
      case "build": {
        const result = operations.buildProject(cwd);
        emitSuccess(parsed.json, "BUILD_OK", { codePath: result.codePath, manifestPath: result.manifestPath, bytes: result.bundle.manifest.byteLength, sha256: result.bundle.manifest.sha256 }, writer);
        return 0;
      }
      case "dev": {
        const result = await operations.devProject(cwd);
        emitSuccess(parsed.json, "DEV_OK", { bundleId: result.bundleId, generation: result.generation, texts: result.texts }, writer);
        return 0;
      }
      case "doctor": {
        const result = operations.doctorProject(cwd);
        emitDoctor(result, parsed.json, writer);
        return result.ok ? 0 : 1;
      }
      default:
        throw new CliError(DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND, `unknown command: ${parsed.command}`, {}, 2);
    }
  } catch (error) {
    const cliError = asCliError(error);
    emitFailure(cliError, parsed.json, writer);
    return cliError.exitCode;
  }
}

function emitDoctor(result: DoctorResult, json: boolean, writer: CliWriter): void {
  if (json) {
    writer.log(JSON.stringify({ ok: result.ok, code: result.resultCode, resultCode: result.resultCode, checks: result.checks }));
    return;
  }
  for (const check of result.checks) {
    writer.log(`${check.ok ? "PASS" : "FAIL"} ${check.id} ${check.ok ? check.successCode : check.diagnosticCode}: ${check.detail}`);
  }
}

function emitSuccess(json: boolean, code: string, data: Readonly<Record<string, unknown>>, writer: CliWriter): void {
  writer.log(json ? JSON.stringify({ ok: true, ...data, code }) : `${code}: ${JSON.stringify(data)}`);
}

function emitFailure(error: CliError, json: boolean, writer: CliWriter): void {
  if (json) {
    writer.error(JSON.stringify({ ok: false, code: error.code, message: error.message, ...error.details }));
    return;
  }
  writer.error(`tsx-lvgl[${error.code}]: ${error.message}`);
  if (error.code === DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND || error.code === DIAGNOSTIC_CODES.CHECK_FAILED) writer.error(USAGE);
}

function usageError(message: string): CliError {
  return new CliError(DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND, message, {}, 2);
}
