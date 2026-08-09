#!/usr/bin/env node

import { basename } from "node:path";

import {
  asCliError,
  CliError,
  DIAGNOSTIC_CODES,
} from "./diagnostics.js";
import {
  buildProject,
  checkProject,
  createProject,
  devProject,
  doctorProject,
  syncProject,
  updateProject,
} from "./project.js";

const USAGE = `Usage:
  tsx-lvgl create <directory> [--artifact <sdk.tgz>]
  tsx-lvgl sync [--json]
  tsx-lvgl update [--source <framework-checkout>] [--json]
  tsx-lvgl dev [--json]
  tsx-lvgl check [--json]
  tsx-lvgl build [--json]
  tsx-lvgl doctor [--json]

The app-facing interface is deliberately limited to these commands.\n`;

interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly json: boolean;
  readonly artifact?: string;
  readonly source?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] ?? "help";
  const positional: string[] = [];
  let json = false;
  let artifact: string | undefined;
  let source: string | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    // npm strips the conventional script-argument delimiter, while pnpm may
    // forward it and Bun accepts it before the forwarded arguments. Treat the
    // delimiter consistently so JSON diagnostics are package-manager neutral.
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

  return {
    command,
    positional,
    json,
    ...(artifact === undefined ? {} : { artifact }),
    ...(source === undefined ? {} : { source }),
  };
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    emitFailure(asCliError(error), process.argv.slice(2).includes("--json"));
    process.exitCode = 2;
    return;
  }

  if (parsed.command === "help") {
    console.log(USAGE);
    return;
  }

  try {
    switch (parsed.command) {
      case "create": {
        const target = parsed.positional[0];
        if (target === undefined) throw usageError("create requires a target directory");
        const result = createProject(target, parsed.artifact);
        emitSuccess(parsed.json, "CREATE_OK", {
          project: basename(result.root),
          artifact: result.lock.artifact.file,
          sourceSha: result.lock.sourceSha,
        });
        return;
      }
      case "sync": {
        const result = syncProject(process.cwd());
        emitSuccess(parsed.json, "SYNC_OK", { version: result.lock.version, sourceSha: result.lock.sourceSha });
        return;
      }
      case "update": {
        const result = updateProject(process.cwd(), parsed.source);
        emitSuccess(parsed.json, "UPDATE_OK", { version: result.lock.version, sourceSha: result.lock.sourceSha });
        return;
      }
      case "check": {
        const result = checkProject(process.cwd());
        emitSuccess(parsed.json, "CHECK_OK", { files: result.files });
        return;
      }
      case "build": {
        const result = buildProject(process.cwd());
        emitSuccess(parsed.json, "BUILD_OK", {
          codePath: result.codePath,
          manifestPath: result.manifestPath,
          bytes: result.bundle.manifest.byteLength,
          sha256: result.bundle.manifest.sha256,
        });
        return;
      }
      case "dev": {
        const result = await devProject(process.cwd());
        emitSuccess(parsed.json, "DEV_OK", {
          bundleId: result.bundleId,
          generation: result.generation,
          texts: result.texts,
        });
        return;
      }
      case "doctor": {
        const result = doctorProject(process.cwd());
        if (parsed.json) {
          console.log(JSON.stringify({ ok: result.ok, code: result.ok ? "DOCTOR_OK" : "DOCTOR_FAILED", checks: result.checks }));
        } else {
          for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.code}: ${check.detail}`);
        }
        if (!result.ok) process.exitCode = 1;
        return;
      }
      default:
        throw new CliError(DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND, `unknown command: ${parsed.command}`, {}, 2);
    }
  } catch (error) {
    emitFailure(asCliError(error), parsed.json);
    process.exitCode = asCliError(error).exitCode;
  }
}

function emitSuccess(json: boolean, code: string, data: Readonly<Record<string, unknown>>): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...data, code }));
    return;
  }
  console.log(`${code}: ${JSON.stringify(data)}`);
}

function emitFailure(error: CliError, json: boolean): void {
  if (json) {
    console.error(JSON.stringify({ ok: false, code: error.code, message: error.message, ...error.details }));
    return;
  }
  console.error(`tsx-lvgl[${error.code}]: ${error.message}`);
  if (error.code === DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND || error.code === DIAGNOSTIC_CODES.CHECK_FAILED) console.error(USAGE);
}

function usageError(message: string): CliError {
  return new CliError(DIAGNOSTIC_CODES.UNSUPPORTED_COMMAND, message, {}, 2);
}

await main();
