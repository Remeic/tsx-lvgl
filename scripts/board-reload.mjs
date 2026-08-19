import { appendFile, chmod, open, readFile, realpath, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { APP_FLASH_OFFSET, buildReloadPlan } from "./board-reload-plan.mjs";
import { resolveBoardProfile } from "./board-profile.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRunPython = "/absolute/path/to/esptool-5.3.1-venv/bin/python";
const dryRunPort = "/dev/cu.EXAMPLE";

function usage() {
  return `Usage:
  npm run board:reload -- [options] --execute
  npm run board:reload -- --dry-run

Options:
  --execute                  Run the logged physical app-only reload.
  --dry-run                  Print the plan without touching hardware (default).
  --port PATH                Current serial path, for example /dev/cu.usbmodem101.
  --recovery-dir PATH        External recovery directory containing the manifest.
  --esptool-python PATH      Python executable with esptool/espefuse 5.3.1.
  --artifact PATH             App image; defaults to the selected target artifact.
  --target KEY                Explicit repository board target (required).
  --baud NUMBER               Serial baud rate; defaults to 115200.
  --reset-mode MODE          hard-reset or watchdog-reset; default watchdog-reset.
  --help                     Show this help.

The physical mode requires --port, --recovery-dir and --esptool-python (or the
TSX_LVGL_RECOVERY_DIR and ESPTOOL_PYTHON environment variables). It creates a
0600 operation log before the first serial command and refuses /Volumes paths.
`;
}

function parseCli(argv) {
  const options = {
    execute: false,
    dryRun: true,
    port: process.env.TSX_LVGL_BOARD_PORT ?? dryRunPort,
    recoveryDir: process.env.TSX_LVGL_RECOVERY_DIR ?? "",
    esptoolPython: process.env.ESPTOOL_PYTHON ?? dryRunPython,
    artifact: "",
    target: "",
    baud: 115200,
    resetMode: "watchdog-reset",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
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

  if (!isAbsolute(options.esptoolPython)) {
    options.esptoolPython = resolve(options.esptoolPython);
  }
  if (options.artifact && !isAbsolute(options.artifact)) {
    options.artifact = resolve(options.artifact);
  }
  if (options.recoveryDir) {
    options.recoveryDir = resolve(options.recoveryDir);
  }
  if (!options.target) throw new Error("--target is required");
  if (!options.artifact) options.artifact = resolveBoardProfile(options.target, repoRoot).artifact;
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

function canonicalEfuseDump(output) {
  const rows = [];
  const pattern = /^([A-Z0-9_]+)[ \t]+\([^)]*\)[ \t]+\[[ \t]*\d+[ \t]*\][ \t]+dump:[ \t]+([0-9a-f ]+)$/gim;
  for (const match of output.matchAll(pattern)) {
    rows.push(`${match[1]}|${match[2].replaceAll(/\s+/g, " ").trim().toLowerCase()}`);
  }
  return rows.join("\n");
}

function parseManifestIdentity(manifest) {
  const mac = manifest.match(/^- Factory MAC:\s*`([^`]+)`/m)?.[1];
  const uniqueId = manifest.match(/^- Optional unique ID:\s*`([^`]+)`/m)?.[1];
  if (!mac || !uniqueId) {
    throw new Error("recovery manifest is missing Factory MAC or Optional unique ID");
  }
  return { mac, uniqueId };
}

async function loadRecoveryContext(recoveryDir) {
  if (!recoveryDir || !isAbsolute(recoveryDir)) {
    throw new Error("--recovery-dir must be an absolute local path");
  }
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
  if (!expectedDump) {
    throw new Error("baseline efuse-dump.txt contains no canonical dump rows");
  }
  const backupB = await readFile(join(resolvedRecoveryDir, "factory-16mb-b.bin"));
  const backupC = await readFile(join(resolvedRecoveryDir, "factory-16mb-c.bin"));
  if (backupB.length !== 0x1000000 || backupC.length !== 0x1000000) {
    throw new Error("factory B/C recovery images are not complete 16 MiB files");
  }
  if (!backupB.equals(backupC)) {
    throw new Error("factory B/C recovery images differ; refusing app write");
  }
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

async function realLocalDirectory(path, label) {
  const resolved = resolve(path);
  if (isExternalVolumePath(resolved)) {
    throw new Error(`${label} must be on the local disk; /Volumes paths are forbidden`);
  }
  const real = await realpath(resolved);
  if (isExternalVolumePath(real)) {
    throw new Error(`${label} resolves to /Volumes; external media are forbidden`);
  }
  const info = await stat(real);
  if (!info.isDirectory()) {
    throw new Error(`${label} is not a directory: ${real}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${label} must be owner-only (0700): ${real}`);
  }
  return real;
}

async function artifactInfo(artifact) {
  const resolved = resolve(artifact);
  if (isExternalVolumePath(resolved)) {
    throw new Error("artifact must be on the local disk; /Volumes paths are forbidden");
  }
  const info = await stat(resolved);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`artifact is missing or empty: ${resolved}`);
  }
  if (info.size > 0x800000) {
    throw new Error(`artifact exceeds the 8 MiB factory partition: ${resolved}`);
  }
  const bytes = await readFile(resolved);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { path: resolved, size: info.size, sha256 };
}

function spawnCapture(command, onOutput = null) {
  return new Promise((resolveResult) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputQueue = Promise.resolve();
    let settled = false;
    const forward = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (onOutput) {
        outputQueue = outputQueue.then(() => onOutput(text));
      }
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

async function createOperationLog(options, plan, info, context) {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
  const nonce = randomBytes(3).toString("hex");
  const logPath = join(context.recoveryDir, `operation-app-install-${timestamp}-${nonce}.md`);
  const gitRevision = (await spawnCapture(["git", "rev-parse", "HEAD"])).output.trim() || "unknown";
  const gitStatus = (await spawnCapture(["git", "status", "--short"])).output.trim() || "clean";
  const handle = await open(logPath, "wx", 0o600);
  await handle.writeFile(`# TSX-LVGL ${options.target} app-only firmware install\n\n` +
    `- Status: START — no hardware command has run yet\n` +
    `- Created: ${new Date().toISOString()}\n` +
    `- Repository: ${repoRoot}\n` +
    `- Git revision: ${gitRevision}\n` +
    `- Worktree status: ${gitStatus.replaceAll("\n", "; ")}\n` +
    `- Serial path: ${options.port} (transport only; not identity)\n` +
    `- Recovery directory: ${context.recoveryDir}\n` +
    `- Target key: ${options.target}\n` +
    `- Board ID: ${resolveBoardProfile(options.target, repoRoot).boardId}\n` +
    `- Artifact: ${info.path}\n` +
    `- Artifact size: ${info.size}\n` +
    `- Artifact SHA-256: ${info.sha256}\n` +
    `- Factory B/C size: ${context.factoryBackup.size}\n` +
    `- Factory B/C SHA-256: ${context.factoryBackup.sha256}\n` +
    `- Flash offset: ${APP_FLASH_OFFSET}\n` +
    `- Reset mode: ${options.resetMode}\n` +
    `- Mutation scope: application image only; no bootloader, partition table, global erase, eFuse or external volume access\n` +
    `- Precondition: complete same-session identity/security/eFuse preflight must pass before write\n\n` +
    `## Planned commands\n\n` +
    plan.steps.map((step) => `- ${step.name}: \`${formatCommand(step.command)}\``).join("\n") +
    "\n");
  await handle.close();
  await chmod(logPath, 0o600);
  return logPath;
}

async function runLoggedStep(logPath, step, validator) {
  await appendLog(logPath, `\n## ${step.name}\n\n\`\`\`text\n$ ${formatCommand(step.command)}\n`);
  const result = await spawnCapture(step.command, (chunk) => appendLog(logPath, chunk));
  await appendLog(logPath, `\n\`\`\`\nExit status: ${result.code}\n`);
  if (result.code !== 0) {
    throw new Error(`${step.name} failed with exit status ${result.code}`);
  }
  validator(result.output);
  await appendLog(logPath, `Validation: PASS\n`);
  return result.output;
}

function validateStep(name, output, context, info, resetMode) {
  switch (name) {
    case "chip-id":
      requireFragments(output, [
        "ESP32-S3",
        "QFN56",
        "revision v0.2",
        "Embedded PSRAM 8MB",
        context.mac,
      ], name);
      break;
    case "flash-id":
      requireFragments(output, [
        "Manufacturer: 20",
        "Device: 4018",
        "Detected flash size: 16MB",
        "Flash type set in eFuse: quad",
        "Flash voltage set by eFuse: 3.3V",
      ], name);
      break;
    case "read-mac":
      requireFragments(output, [`MAC: ${context.mac}`], name);
      break;
    case "security-info":
      requireFragments(output, [
        "Secure Boot: Disabled",
        "Flash Encryption: Disabled",
        "SPI Boot Crypt Count (SPI_BOOT_CRYPT_CNT): 0x0",
      ], name);
      break;
    case "efuse-summary":
      requireFragments(output, [
        context.mac,
        context.uniqueId,
        "SPI_BOOT_CRYPT_CNT",
        "SECURE_BOOT_EN",
        "ENABLE_SECURITY_DOWNLOAD",
        "DIS_DOWNLOAD_MODE",
        "WR_DIS",
        "RD_DIS",
      ], name);
      break;
    case "efuse-dump":
      if (canonicalEfuseDump(output) !== context.expectedDump) {
        throw new Error(`${name} differs from the accepted baseline dump`);
      }
      break;
    case "write-flash":
      requireFragments(output, ["Hash of data verified", "Staying in bootloader"], name);
      if (!output.includes(`Wrote ${info.size} bytes`)) {
        throw new Error(`${name} did not report the expected byte count ${info.size}`);
      }
      break;
    case "verify-flash":
      requireFragments(output, ["Verification successful"], name);
      break;
    case "reset":
      requireFragments(output, [context.mac], name);
      requireFragments(output, [
        resetMode === "watchdog-reset" ? "Hard resetting with a watchdog" : "Hard resetting via RTS pin",
      ], name);
      break;
    default:
      throw new Error(`no validator for ${name}`);
  }
}

function validateImageInfo(output, info) {
  requireFragments(output, [
    `Image size: ${info.size} bytes`,
    "Flash size: 16MB",
    "Flash freq: 80m",
    "Flash mode: DIO",
  ], "image-info");
  if (!/Checksum:.*\(valid\)/i.test(output) || !/Validation hash:.*\(valid\)/i.test(output)) {
    throw new Error("image-info did not report valid checksum and validation hash");
  }
}

async function run() {
  const options = parseCli(process.argv.slice(2));
  const plan = buildReloadPlan({
    esptoolPython: options.esptoolPython,
    port: options.port,
    artifact: options.artifact,
    baud: options.baud,
    resetMode: options.resetMode,
  });

  if (options.dryRun) {
    console.log("DRY RUN — no hardware, recovery directory, or external volume access");
    console.log(`Mutation scope: ${plan.mutationScope}`);
    for (const step of plan.steps) {
      console.log(`${step.name}: ${formatCommand(step.command)}`);
    }
    return;
  }

  if (!options.port || options.port === dryRunPort) {
    throw new Error("physical mode requires --port");
  }
  if (!options.recoveryDir) {
    throw new Error("physical mode requires --recovery-dir or TSX_LVGL_RECOVERY_DIR");
  }
  if (!process.env.ESPTOOL_PYTHON && options.esptoolPython === dryRunPython) {
    throw new Error("physical mode requires --esptool-python or ESPTOOL_PYTHON");
  }
  await stat(options.esptoolPython).catch(() => {
    throw new Error(`esptool Python executable does not exist: ${options.esptoolPython}`);
  });

  const context = await loadRecoveryContext(options.recoveryDir);
  const info = await artifactInfo(options.artifact);
  const logPath = await createOperationLog(options, plan, info, context);
  console.log(`Recovery log created before hardware access: ${logPath}`);

  try {
    const imageInfoCommand = [
      options.esptoolPython,
      "-m",
      "esptool",
      "--chip",
      "esp32s3",
      "image-info",
      info.path,
    ];
    const imageInfoStep = { name: "image-info-offline", command: imageInfoCommand };
    await runLoggedStep(logPath, imageInfoStep, (output) => validateImageInfo(output, info));

    for (const step of plan.steps) {
      await runLoggedStep(logPath, step, (output) =>
        validateStep(step.name, output, context, info, options.resetMode));
    }

    await appendLog(logPath,
      "\n## Terminal result\n\n" +
      "- PASS — app-only write, immediate verify, and selected reset transport completed.\n" +
      "- User-visible display/touch validation remains a separate manual gate.\n");
    console.log(`Reload transport PASS. Manual display/touch validation remains required. Log: ${logPath}`);
  } catch (error) {
    await appendLog(logPath,
      "\n## Terminal result\n\n" +
      `- FAIL/UNKNOWN — ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  run().catch((error) => {
    console.error(`board-reload: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { canonicalEfuseDump, parseCli, parseManifestIdentity, validateImageInfo };
