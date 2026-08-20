import {
  appendFile,
  chmod,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  compareLivePartitionTable,
  readArtifactDescriptor,
  validateArtifactDescriptor,
} from "./board-artifact-descriptor.mjs";
import { resolveBoardProfile } from "./board-profile.mjs";
import {
  buildReloadMutationPlan,
  buildReloadPreflightPlan,
  formatFlashAddress,
} from "./board-reload-plan.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRunPython = "/absolute/path/to/esptool-5.3.1-venv/bin/python";
const dryRunPort = "/dev/cu.EXAMPLE";

function usage() {
  return `Usage:
  npm run board:reload -- [options] --execute
  npm run board:reload -- --dry-run

Options:
  --execute                  Run the logged physical app-only reload.
  --dry-run                  Print the read-only plan without touching hardware (default).
  --preflight-only           Read and validate the live table, then stop before mutation.
  --port PATH                Current serial path, for example /dev/cu.usbmodem101.
  --recovery-dir PATH        External recovery directory containing the manifest.
  --esptool-python PATH      Python executable with esptool/espefuse 5.3.1.
  --artifact PATH             Custom app image; requires --descriptor.
  --descriptor PATH           Matching versioned artifact descriptor.
  --target KEY                Explicit repository board target (required).
  --baud NUMBER               Serial baud rate; defaults to 115200.
  --reset-mode MODE           hard-reset or watchdog-reset; default watchdog-reset.
  --help                      Show this help.

The physical mode requires --port, --recovery-dir and --esptool-python (or the
TSX_LVGL_RECOVERY_DIR and ESPTOOL_PYTHON environment variables). It creates a
0600 operation log and a 0700 temporary read directory before the first serial
command, and refuses /Volumes paths.
`;
}

export function parseCli(argv, env = process.env) {
  const options = {
    execute: false,
    dryRun: true,
    preflightOnly: false,
    port: env.TSX_LVGL_BOARD_PORT ?? dryRunPort,
    recoveryDir: env.TSX_LVGL_RECOVERY_DIR ?? "",
    esptoolPython: env.ESPTOOL_PYTHON ?? dryRunPython,
    artifact: "",
    descriptor: "",
    target: "",
    baud: 115200,
    resetMode: "watchdog-reset",
  };
  let artifactSpecified = false;
  let descriptorSpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--execute") {
      options.execute = true;
      options.dryRun = false;
      continue;
    }
    if (argument === "--dry-run") {
      options.execute = false;
      options.dryRun = true;
      continue;
    }
    if (argument === "--preflight-only") {
      options.preflightOnly = true;
      continue;
    }

    const [name, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }

    switch (name) {
      case "--port":
        options.port = value;
        break;
      case "--recovery-dir":
        options.recoveryDir = value;
        break;
      case "--esptool-python":
        options.esptoolPython = value;
        break;
      case "--artifact":
        options.artifact = resolve(value);
        artifactSpecified = true;
        break;
      case "--descriptor":
        options.descriptor = resolve(value);
        descriptorSpecified = true;
        break;
      case "--target":
        options.target = value;
        break;
      case "--baud":
        options.baud = Number(value);
        break;
      case "--reset-mode":
        options.resetMode = value;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }

  if (!isAbsolute(options.esptoolPython)) options.esptoolPython = resolve(options.esptoolPython);
  if (options.recoveryDir) options.recoveryDir = resolve(options.recoveryDir);
  if (!options.target) throw new Error("--target is required");
  const profile = resolveBoardProfile(options.target, repoRoot);
  if (!artifactSpecified) options.artifact = profile.artifact;
  if (!descriptorSpecified) {
    if (artifactSpecified) throw new Error("--artifact requires an explicit --descriptor");
    options.descriptor = profile.descriptorPath;
  }
  options.help = false;
  return options;
}

function formatCommand(command) {
  return command
    .map((part) => (/^[A-Za-z0-9_./:=+,-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`))
    .join(" ");
}

function isExternalVolumePath(path) {
  return path === "/Volumes" || path.startsWith("/Volumes/");
}

function normalize(value) {
  return value.toLowerCase().replaceAll(/\s+/g, " ").trim();
}

function requireFragments(output, fragments, label) {
  const normalized = normalize(output);
  for (const fragment of fragments) {
    if (!normalized.includes(normalize(fragment))) {
      throw new Error(`${label} is missing expected evidence: ${fragment}`);
    }
  }
}

export function canonicalEfuseDump(output) {
  const rows = [];
  const pattern = /^([A-Z0-9_]+)[ \t]+\([^)]*\)[ \t]+\[[ \t]*\d+[ \t]*\][ \t]+dump:[ \t]+([0-9a-f ]+)$/gim;
  for (const match of output.matchAll(pattern)) {
    rows.push(`${match[1]}|${match[2].replaceAll(/\s+/g, " ").trim().toLowerCase()}`);
  }
  return rows.join("\n");
}

export function parseManifestIdentity(manifest) {
  const mac = manifest.match(/^- Factory MAC:\s*`([^`]+)`/m)?.[1];
  const uniqueId = manifest.match(/^- Optional unique ID:\s*`([^`]+)`/m)?.[1];
  if (!mac || !uniqueId) throw new Error("recovery manifest is missing Factory MAC or Optional unique ID");
  return { mac, uniqueId };
}

async function realLocalDirectory(path, label) {
  const resolved = resolve(path);
  if (isExternalVolumePath(resolved)) throw new Error(`${label} must be on the local disk; /Volumes paths are forbidden`);
  const real = await realpath(resolved);
  if (isExternalVolumePath(real)) throw new Error(`${label} resolves to /Volumes; external media are forbidden`);
  const info = await stat(real);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${real}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only (0700): ${real}`);
  return real;
}

async function loadRecoveryContext(recoveryDir) {
  if (!recoveryDir || !isAbsolute(recoveryDir)) throw new Error("--recovery-dir must be an absolute local path");
  const resolvedRecoveryDir = await realLocalDirectory(recoveryDir, "recovery directory");
  const requiredFiles = [
    "recovery-manifest.md",
    "flash-id.txt",
    "read-mac.txt",
    "security-info.txt",
    "efuse-summary.txt",
    "efuse-dump.txt",
    "esptool-version.txt",
    "factory-validated-bc.sha256",
  ];
  for (const file of requiredFiles) {
    const filePath = join(resolvedRecoveryDir, file);
    await stat(filePath).catch(() => {
      throw new Error(`recovery evidence is missing: ${filePath}`);
    });
  }

  const manifest = await readFile(join(resolvedRecoveryDir, "recovery-manifest.md"), "utf8");
  const efuseDump = await readFile(join(resolvedRecoveryDir, "efuse-dump.txt"), "utf8");
  const backupLedger = await readFile(join(resolvedRecoveryDir, "factory-validated-bc.sha256"), "utf8");
  requireFragments(manifest, [
    "Recovery SHA-256 ledger:",
    "ACCEPTED FOR SAME-BOARD RECOVERY",
    "Independent archives:",
    "CONDITIONAL PASS",
  ], "recovery manifest");
  const identity = parseManifestIdentity(manifest);
  const expectedDump = canonicalEfuseDump(efuseDump);
  if (!expectedDump) throw new Error("baseline efuse-dump.txt contains no canonical dump rows");
  const backupB = await readFile(join(resolvedRecoveryDir, "factory-16mb-b.bin"));
  const backupC = await readFile(join(resolvedRecoveryDir, "factory-16mb-c.bin"));
  if (backupB.length !== 0x1000000 || backupC.length !== 0x1000000) {
    throw new Error("factory B/C recovery images are not complete 16 MiB files");
  }
  if (!backupB.equals(backupC)) throw new Error("factory B/C recovery images differ; refusing app write");
  const backupSha256 = createHash("sha256").update(backupB).digest("hex");
  const ledgerHashes = [...backupLedger.matchAll(/^([0-9a-f]{64})[ \t]+/gim)].map((match) => match[1].toLowerCase());
  if (ledgerHashes.length < 2 || ledgerHashes[0] !== backupSha256 || ledgerHashes[1] !== backupSha256) {
    throw new Error("factory B/C files do not match the accepted SHA-256 ledger");
  }
  return {
    recoveryDir: resolvedRecoveryDir,
    ...identity,
    expectedDump,
    factoryBackup: { size: backupB.length, sha256: backupSha256 },
  };
}

export async function artifactInfo(artifact) {
  const resolved = resolve(artifact);
  if (isExternalVolumePath(resolved)) throw new Error("artifact must be on the local disk; /Volumes paths are forbidden");
  const info = await stat(resolved);
  if (!info.isFile() || info.size === 0) throw new Error(`artifact is missing or empty: ${resolved}`);
  const bytes = await readFile(resolved);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { path: resolved, size: info.size, byteLength: info.size, sha256 };
}

export function spawnCapture(command, onOutput = null, cwd = repoRoot) {
  return new Promise((resolveResult) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputQueue = Promise.resolve();
    let settled = false;
    const forward = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (onOutput) outputQueue = outputQueue.then(() => onOutput(text));
      return text;
    };
    child.stdout.on("data", (chunk) => {
      const text = forward(chunk);
      stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      const text = forward(chunk);
      stderr += text;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      const text = `${error.message}\n`;
      process.stdout.write(text);
      if (onOutput) outputQueue = outputQueue.then(() => onOutput(text));
      outputQueue.then(() => resolveResult({ code: 127, output: `${stdout}${stderr}${text}` }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      outputQueue.then(() => resolveResult({ code: code ?? 1, output: `${stdout}${stderr}` }));
    });
  });
}

async function appendLog(logPath, text) {
  await appendFile(logPath, text, { mode: 0o600 });
}

async function createOperationLog(options, plan, info, context, profile, descriptor, capture, root, onCreated = null) {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
  const nonce = randomBytes(3).toString("hex");
  const logPath = join(context.recoveryDir, `operation-app-install-${timestamp}-${nonce}.md`);
  const gitRevision = (await capture(["git", "rev-parse", "HEAD"])).output.trim() || "unknown";
  const gitStatus = (await capture(["git", "status", "--short"])).output.trim() || "clean";
  const handle = await open(logPath, "wx", 0o600);
  try {
    onCreated?.(logPath);
    await handle.writeFile(
      `# TSX-LVGL ${options.target} app-only firmware install\n\n` +
      `- Status: START — no hardware command has run yet\n` +
      `- Created: ${new Date().toISOString()}\n` +
      `- Repository: ${root}\n` +
      `- Git revision: ${gitRevision}\n` +
      `- Worktree status: ${gitStatus.replaceAll("\n", "; ")}\n` +
      `- Serial path: ${options.port} (transport only; not identity)\n` +
      `- Recovery directory: ${context.recoveryDir}\n` +
      `- Target key: ${options.target}\n` +
      `- Board ID: ${profile.boardId}\n` +
      `- Artifact: ${info.path}\n` +
      `- Artifact size: ${info.size}\n` +
      `- Artifact SHA-256: ${info.sha256}\n` +
      `- Descriptor: ${options.descriptor}\n` +
      `- Descriptor source SHA: ${descriptor.sourceSha}\n` +
      `- Partition-table flash offset: ${formatFlashAddress(descriptor.partitionTable.flashOffset)}\n` +
      `- Partition-table read size: ${descriptor.partitionTable.readSize}\n` +
      `- Expected partition-table semantic SHA-256: ${descriptor.partitionTable.semanticSha256}\n` +
      `- Expected application partition: ${JSON.stringify(descriptor.applicationPartition)}\n` +
      `- Factory B/C size: ${context.factoryBackup.size}\n` +
      `- Factory B/C SHA-256: ${context.factoryBackup.sha256}\n` +
      `- Reset mode: ${options.resetMode}\n` +
      `- Mutation scope: validated application partition only; no bootloader, partition table, global erase, eFuse or external volume access\n` +
      `- Precondition: complete same-session identity/security/eFuse and live-layout preflight must pass before write\n\n` +
      `## Planned read-only commands\n\n` +
      plan.steps.map((step) => `- ${step.name}: \`${formatCommand(step.command)}\``).join("\n") +
      "\n",
    );
  } finally {
    await handle.close();
  }
  await chmod(logPath, 0o600);
  return logPath;
}

async function appendMutationPlan(logPath, plan) {
  await appendLog(
    logPath,
    `\n## Gated mutation commands\n\n` +
    `- Live partition layout validation: PASS\n` +
    plan.steps.map((step) => `- ${step.name}: \`${formatCommand(step.command)}\``).join("\n") +
    "\n",
  );
}

async function runLoggedStep(logPath, step, validator, capture = spawnCapture) {
  await appendLog(logPath, `\n## ${step.name}\n\n\`\`\`text\n$ ${formatCommand(step.command)}\n`);
  const result = await capture(step.command, (chunk) => appendLog(logPath, chunk));
  await appendLog(logPath, `\n\`\`\`\nExit status: ${result.code}\n`);
  if (result.code !== 0) throw new Error(`${step.name} failed with exit status ${result.code}`);
  validator(result.output);
  await appendLog(logPath, "Validation: PASS\n");
  return result.output;
}

function validateStep(name, output, context, info, resetMode) {
  switch (name) {
    case "chip-id":
      requireFragments(output, ["ESP32-S3", "QFN56", "revision v0.2", "Embedded PSRAM 8MB", context.mac], name);
      break;
    case "flash-id":
      requireFragments(output, ["Manufacturer: 20", "Device: 4018", "Detected flash size: 16MB", "Flash type set in eFuse: quad", "Flash voltage set by eFuse: 3.3V"], name);
      break;
    case "read-mac":
      requireFragments(output, [`MAC: ${context.mac}`], name);
      break;
    case "security-info":
      requireFragments(output, ["Secure Boot: Disabled", "Flash Encryption: Disabled", "SPI Boot Crypt Count (SPI_BOOT_CRYPT_CNT): 0x0"], name);
      break;
    case "efuse-summary":
      requireFragments(output, [context.mac, context.uniqueId, "SPI_BOOT_CRYPT_CNT", "SECURE_BOOT_EN", "ENABLE_SECURITY_DOWNLOAD", "DIS_DOWNLOAD_MODE", "WR_DIS", "RD_DIS"], name);
      break;
    case "efuse-dump":
      if (canonicalEfuseDump(output) !== context.expectedDump) throw new Error(`${name} differs from the accepted baseline dump`);
      break;
    case "read-partition-table":
      break;
    case "write-flash":
      requireFragments(output, ["Hash of data verified", "Staying in bootloader"], name);
      if (!output.includes(`Wrote ${info.size} bytes`)) throw new Error(`${name} did not report the expected byte count ${info.size}`);
      break;
    case "verify-flash":
      requireFragments(output, ["Verification successful"], name);
      break;
    case "reset":
      requireFragments(output, [context.mac], name);
      requireFragments(output, [resetMode === "watchdog-reset" ? "Hard resetting with a watchdog" : "Hard resetting via RTS pin"], name);
      break;
    default:
      throw new Error(`no validator for ${name}`);
  }
}

export function validateImageInfo(output, info) {
  requireFragments(output, [`Image size: ${info.size} bytes`, "Flash size: 16MB", "Flash freq: 80m", "Flash mode: DIO"], "image-info");
  if (!/Checksum:.*\(valid\)/i.test(output) || !/Validation hash:.*\(valid\)/i.test(output)) {
    throw new Error("image-info did not report valid checksum and validation hash");
  }
}

async function createSecureLiveTableFile(recoveryDir, onPartial = null) {
  const directory = await mkdtemp(join(recoveryDir, ".tsx-lvgl-live-partition-"));
  const path = join(directory, "partition-table.bin");
  onPartial?.({ directory, path });
  await chmod(directory, 0o700);
  const handle = await open(path, "wx", 0o600);
  await handle.close();
  await chmod(path, 0o600);
  return { directory, path };
}

async function readLiveTable(path, expectedSize) {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error("live partition-table file must remain owner-only (0600)");
  const bytes = await readFile(path);
  if (bytes.byteLength !== expectedSize) {
    throw new Error(`live partition-table read must be exactly ${expectedSize} bytes`);
  }
  return bytes;
}

async function appendLiveLayoutEvidence(logPath, layout) {
  await appendLog(
    logPath,
    `\n## Live partition layout\n\n` +
    `- Raw read SHA-256: ${layout.rawSha256}\n` +
    `- Semantic partition-table SHA-256: ${layout.semanticSha256}\n` +
    `- Target key: ${layout.targetKey}\n` +
    `- Board ID: ${layout.boardId}\n` +
    `- Observed application partition: ${JSON.stringify(layout.applicationPartition)}\n` +
    `- Artifact byte length checked: ${layout.artifactByteLength}\n` +
    `- Comparison: PASS\n`,
  );
}

function printDryRun(options, profile) {
  console.log("DRY RUN — no hardware, recovery directory, or external volume access");
  console.log("Live partition layout: NOT READ (dry-run does not claim validation)");
  console.log(`Generated build metadata: ${profile.buildMetadataPath} (required for descriptor generation)`);
  console.log("Mutation scope: application-only after validated live partition layout");
  console.log("preflight: <not constructed until the generated build descriptor supplies the partition-table offset>");
  console.log("mutation: <not constructed until validated live partition layout>");
}

/**
 * Execute a physical reload with the live-layout gate. The optional capture
 * dependency is a host-only test seam; it is never used to bypass validation.
 */
export async function runReload(options, {
  capture = spawnCapture,
  root = repoRoot,
  artifactInfoReader = artifactInfo,
  descriptorReader = readArtifactDescriptor,
  recoveryContextLoader = loadRecoveryContext,
  temporaryFileFactory = createSecureLiveTableFile,
  operationLogFactory = createOperationLog,
} = {}) {
  const profile = resolveBoardProfile(options.target, root);
  if (options.dryRun) {
    printDryRun(options, profile);
    return { status: "DRY_RUN" };
  }
  let temporary = null;
  let logPath = null;
  let failure;
  let terminalLogged = false;
  try {
    if (!options.port || options.port === dryRunPort) throw new Error("physical mode requires --port");
    if (!options.recoveryDir) throw new Error("physical mode requires --recovery-dir or TSX_LVGL_RECOVERY_DIR");
    if (!process.env.ESPTOOL_PYTHON && options.esptoolPython === dryRunPython) {
      throw new Error("physical mode requires --esptool-python or ESPTOOL_PYTHON");
    }
    await stat(options.esptoolPython).catch(() => {
      throw new Error(`esptool Python executable does not exist: ${options.esptoolPython}`);
    });

    // Descriptor and artifact checks happen before recovery/serial work. A
    // custom artifact can never silently inherit the profile descriptor.
    if (isExternalVolumePath(options.descriptor)) throw new Error("descriptor must be on the local disk; /Volumes paths are forbidden");
    const info = await artifactInfoReader(options.artifact);
    const descriptor = await descriptorReader(options.descriptor);
    validateArtifactDescriptor({
      descriptor,
      profile,
      artifactPath: info.path,
      artifactInfo: { byteLength: info.byteLength ?? info.size, sha256: info.sha256 },
      repositoryRoot: root,
      descriptorPath: options.descriptor,
    });
    const context = await recoveryContextLoader(options.recoveryDir);
    const trackTemporary = (resource) => {
      temporary = resource;
    };
    temporary = await temporaryFileFactory(context.recoveryDir, trackTemporary);
    if (!temporary || typeof temporary.directory !== "string" || typeof temporary.path !== "string") {
      throw new Error("temporary live-layout resource is invalid");
    }
    const preflightPlan = buildReloadPreflightPlan({
      esptoolPython: options.esptoolPython,
      port: options.port,
      artifact: info.path,
      baud: options.baud,
      resetMode: options.resetMode,
      partitionTableOffset: descriptor.partitionTable.flashOffset,
      partitionTableReadSize: descriptor.partitionTable.readSize,
      livePartitionTablePath: temporary.path,
    });
    const createdLogPath = await operationLogFactory(
      options,
      preflightPlan,
      info,
      context,
      profile,
      descriptor,
      capture,
      root,
      (createdPath) => { logPath = createdPath; },
    );
    if (typeof createdLogPath === "string") logPath = createdLogPath;
    if (!logPath) throw new Error("operation log was not created");
    console.log(`Recovery log created before hardware access: ${logPath}`);

    const imageInfoCommand = [options.esptoolPython, "-m", "esptool", "--chip", "esp32s3", "image-info", info.path];
    await runLoggedStep(logPath, { name: "image-info-offline", command: imageInfoCommand }, (output) => validateImageInfo(output, info), capture);
    for (const step of preflightPlan.steps) {
      await runLoggedStep(logPath, step, (output) => validateStep(step.name, output, context, info, options.resetMode), capture);
    }

    const tableBytes = await readLiveTable(temporary.path, descriptor.partitionTable.readSize);
    const layout = compareLivePartitionTable({
      descriptor,
      tableBytes,
      artifactByteLength: info.byteLength ?? info.size,
    });
    await appendLiveLayoutEvidence(logPath, layout);

    if (options.preflightOnly) {
      terminalLogged = true;
      await appendLog(logPath, "\n## Terminal result\n\n- PASS — live partition layout validated; preflight-only stopped before mutation-plan construction.\n");
      console.log(`Live-layout preflight PASS; no mutation was constructed. Log: ${logPath}`);
      return { status: "PREFLIGHT_PASS", logPath, layout };
    }

    const mutationPlan = buildReloadMutationPlan({
      esptoolPython: options.esptoolPython,
      port: options.port,
      artifact: info.path,
      baud: options.baud,
      resetMode: options.resetMode,
      artifactByteLength: info.byteLength ?? info.size,
    }, layout);
    await appendMutationPlan(logPath, mutationPlan);
    for (const step of mutationPlan.steps) {
      await runLoggedStep(logPath, step, (output) => validateStep(step.name, output, context, info, options.resetMode), capture);
    }
    terminalLogged = true;
    await appendLog(logPath, "\n## Terminal result\n\n- PASS — live-layout-gated app-only write, immediate verify, and selected reset transport completed.\n- User-visible display/touch validation remains a separate manual gate.\n");
      console.log(`Reload transport PASS. Manual display/touch validation remains required. Log: ${logPath}`);
      return { status: "PASS", logPath, layout };
  } catch (error) {
    failure = error;
    if (logPath) {
      try {
        await appendLog(logPath, "\n## Terminal result\n\n" + `- FAIL/UNKNOWN — ${error instanceof Error ? error.message : String(error)}\n`);
        terminalLogged = true;
      } catch {
        // The cleanup boundary still removes the secure temporary resource.
      }
    }
  } finally {
    if (temporary) {
      try {
        await rm(temporary.directory, { recursive: true, force: true });
      } catch (error) {
        const cleanupError = new Error(`cleanup failed for secure live-layout temporary data: ${error instanceof Error ? error.message : String(error)}`);
        if (!failure) failure = cleanupError;
        if (logPath) {
          try {
            await appendLog(
              logPath,
              `${terminalLogged ? "\n- FAIL/UNKNOWN — " : "\n## Terminal result\n\n- FAIL/UNKNOWN — "}${cleanupError.message}\n`,
            );
          } catch {
            // Cleanup diagnostics are best effort when the log itself is unavailable.
          }
        }
      }
    }
  }
  if (failure) throw failure;
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  await runReload(options);
  return 0;
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  run().catch((error) => {
    console.error(`board-reload: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export {
  appendLiveLayoutEvidence,
  createSecureLiveTableFile,
  loadRecoveryContext,
  realLocalDirectory,
  runLoggedStep,
  validateStep,
};
