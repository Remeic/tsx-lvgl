import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { partitionTableFixture, V1_PARTITION_TABLE_ENTRIES } from "./helpers/partition-table-fixture.mjs";
import { compareLivePartitionTable, createArtifactDescriptor, readArtifactDescriptor } from "../scripts/board-artifact-descriptor.mjs";
import { resolveBoardProfile } from "../scripts/board-profile.mjs";
import { buildReloadMutationPlan } from "../scripts/board-reload-plan.mjs";
import { runReload } from "../scripts/board-reload.mjs";

const TARGET = "waveshare-touch-amoled-1.8-v1";
const MAC = "1c:db:d4:7a:06:60";
const UNIQUE_ID = "35 04 64 13 aa f6 0e 7e 7f 9c b2 57 97 1d 95 12";

const v1Table = partitionTableFixture(V1_PARTITION_TABLE_ENTRIES);
const issueTable = partitionTableFixture([
  { label: "nvs", type: 1, subtype: 2, offset: 0x9000, size: 0x6000 },
  { label: "otadata", type: 1, subtype: 0, offset: 0xf000, size: 0x2000 },
  { label: "ota_0", type: 0, subtype: 0x10, offset: 0x110000, size: 0x300000 },
]);

function fakeOutput(command, artifactSize) {
  if (command[0] === "git") return { code: 0, output: "a".repeat(40) };
  if (command.includes("image-info")) {
    return { code: 0, output: `Image size: ${artifactSize} bytes\nFlash size: 16MB\nFlash freq: 80m\nFlash mode: DIO\nChecksum: (valid)\nValidation hash: (valid)\n` };
  }
  if (command.includes("chip-id")) return { code: 0, output: `ESP32-S3 QFN56 revision v0.2 Embedded PSRAM 8MB ${MAC}\n` };
  if (command.includes("flash-id")) return { code: 0, output: "Manufacturer: 20 Device: 4018 Detected flash size: 16MB Flash type set in eFuse: quad Flash voltage set by eFuse: 3.3V\n" };
  if (command.includes("read-mac")) return { code: 0, output: `MAC: ${MAC}\n` };
  if (command.includes("get-security-info")) return { code: 0, output: "Secure Boot: Disabled Flash Encryption: Disabled SPI Boot Crypt Count (SPI_BOOT_CRYPT_CNT): 0x0\n" };
  if (command.includes("summary")) return { code: 0, output: `${MAC} ${UNIQUE_ID} SPI_BOOT_CRYPT_CNT SECURE_BOOT_EN ENABLE_SECURITY_DOWNLOAD DIS_DOWNLOAD_MODE WR_DIS RD_DIS\n` };
  if (command.includes("dump")) return { code: 0, output: "SPI_BOOT_CRYPT_CNT (x) [0] dump: 00\n" };
  return { code: 0, output: "" };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-reload-gate-"));
  const recoveryDir = await mkdtemp(join(tmpdir(), "tsx-lvgl-recovery-"));
  await chmod(recoveryDir, 0o700);
  t.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(recoveryDir, { recursive: true, force: true }),
    ]);
  });
  const profile = resolveBoardProfile(TARGET, root);
  await mkdir(resolve(root, "examples/esp-idf/targets/waveshare_touch_amoled_1_8_v1/build/partition_table"), { recursive: true });
  const artifactBytes = Buffer.from("host-generated artifact");
  await writeFile(profile.artifact, artifactBytes);
  await writeFile(profile.partitionTableBinary, v1Table);
  await writeFile(profile.buildMetadataPath, JSON.stringify({
    flash_files: {
      "0x9000": "partition_table/partition-table.bin",
      "0x10000": "tsx_lvgl_waveshare_v1.bin",
    },
  }));
  await createArtifactDescriptor({
    repositoryRoot: root,
    profile,
    sourceSha: "a".repeat(40),
    artifactPath: profile.artifact,
    partitionTablePath: profile.partitionTableBinary,
    buildMetadataPath: profile.buildMetadataPath,
    outputPath: profile.descriptorPath,
  });
  const context = {
    recoveryDir,
    mac: MAC,
    uniqueId: UNIQUE_ID,
    expectedDump: "SPI_BOOT_CRYPT_CNT|00",
    factoryBackup: { size: 0x1000000, sha256: "a".repeat(64) },
  };
  return { root, profile, recoveryDir, context, artifactSize: artifactBytes.length };
}

test("reload re-checks descriptor source SHA against repository HEAD", async (t) => {
  const testFixture = await fixture(t);
  const raw = JSON.parse(await readFile(testFixture.profile.descriptorPath, "utf8"));
  raw.sourceSha = "b".repeat(40);
  await writeFile(testFixture.profile.descriptorPath, JSON.stringify(raw));
  await assert.rejects(runReload(physicalOptions(testFixture), {
    root: testFixture.root,
    capture: async (command) => ({ code: 0, output: command[0] === "git" ? "a".repeat(40) : "" }),
    recoveryContextLoader: async () => testFixture.context,
  }), /source SHA mismatch/);
});

test("reload rejects a descriptor flash offset that contradicts generated build metadata", async (t) => {
  const testFixture = await fixture(t);
  const raw = JSON.parse(await readFile(testFixture.profile.descriptorPath, "utf8"));
  raw.partitionTable.flashOffset = 0x5000;
  await writeFile(testFixture.profile.descriptorPath, JSON.stringify(raw));
  await assert.rejects(runReload(physicalOptions(testFixture), {
    root: testFixture.root,
    capture: async (command) => fakeOutput(command, testFixture.artifactSize),
    recoveryContextLoader: async () => testFixture.context,
  }), /partition-table flash offset mismatch/);
});

test("preflight-only validates the live table and never constructs mutation commands", async (t) => {
  const testFixture = await fixture(t);
  let observedTable = v1Table;
  const commands = [];
  const capture = async (command, onOutput) => {
    commands.push([...command]);
    if (command.includes("read-flash")) await writeFile(command.at(-1), observedTable);
    const result = fakeOutput(command, testFixture.artifactSize);
    if (onOutput) await onOutput(result.output);
    return result;
  };

  const result = await runReload({
    execute: true,
    dryRun: false,
    preflightOnly: true,
    target: TARGET,
    port: "/dev/cu.test",
    recoveryDir: testFixture.recoveryDir,
    esptoolPython: process.execPath,
    artifact: testFixture.profile.artifact,
    descriptor: testFixture.profile.descriptorPath,
    baud: 115200,
    resetMode: "watchdog-reset",
  }, {
    root: testFixture.root,
    capture,
    recoveryContextLoader: async () => testFixture.context,
  });

  assert.equal(result.status, "PREFLIGHT_PASS");
  assert.ok(commands.some((command) => command.includes("read-flash")));
  assert.equal(commands.some((command) => command.includes("write-flash")), false);
  assert.equal(commands.some((command) => command.includes("verify-flash")), false);
  assert.equal(commands.some((command) => command.includes("watchdog-reset")), false);
  const log = await readFile(result.logPath, "utf8");
  assert.match(log, /Comparison: PASS/);
  assert.doesNotMatch(log, /^- write-flash:/m);
  assert.doesNotMatch(log, /^- verify-flash:/m);
});

test("validated layout is the only source of the observed mutation offset", async (t) => {
  const testFixture = await fixture(t);
  const descriptor = await readArtifactDescriptor(testFixture.profile.descriptorPath);
  const layout = compareLivePartitionTable({
    descriptor,
    tableBytes: v1Table,
    artifactByteLength: testFixture.artifactSize,
  });
  const plan = buildReloadMutationPlan({
    esptoolPython: process.execPath,
    port: "/dev/cu.test",
    artifact: testFixture.profile.artifact,
    baud: 115200,
    resetMode: "watchdog-reset",
    artifactByteLength: testFixture.artifactSize,
  }, layout);
  const write = plan.steps.find((step) => step.name === "write-flash");
  const verify = plan.steps.find((step) => step.name === "verify-flash");
  assert.ok(write.command.includes("0x10000"));
  assert.ok(verify.command.includes("0x10000"));
  assert.ok(write.command.includes("--flash-mode"));
  assert.ok(write.command.includes("keep"));
  assert.ok(write.command.includes("--flash-freq"));
  assert.ok(write.command.includes("--flash-size"));
});

test("live-layout mismatch logs a stable failure before any mutation command", async (t) => {
  const testFixture = await fixture(t);
  let observedTable = issueTable;
  const commands = [];
  const capture = async (command, onOutput) => {
    commands.push([...command]);
    if (command.includes("read-flash")) await writeFile(command.at(-1), observedTable);
    const result = fakeOutput(command, testFixture.artifactSize);
    if (onOutput) await onOutput(result.output);
    return result;
  };

  await assert.rejects(runReload({
    execute: true,
    dryRun: false,
    preflightOnly: false,
    target: TARGET,
    port: "/dev/cu.test",
    recoveryDir: testFixture.recoveryDir,
    esptoolPython: process.execPath,
    artifact: testFixture.profile.artifact,
    descriptor: testFixture.profile.descriptorPath,
    baud: 115200,
    resetMode: "watchdog-reset",
  }, {
    root: testFixture.root,
    capture,
    recoveryContextLoader: async () => testFixture.context,
  }), /LIVE_LAYOUT_MISMATCH/);
  assert.equal(commands.some((command) => command.includes("write-flash")), false);
  assert.equal(commands.some((command) => command.includes("verify-flash")), false);
  const names = await readdir(testFixture.recoveryDir);
  const operationLogs = names.filter((name) => name.startsWith("operation-app-install-"));
  assert.equal(operationLogs.length, 1);
  const log = await readFile(join(testFixture.recoveryDir, operationLogs[0]), "utf8");
  assert.match(log, /FAIL\/UNKNOWN — LIVE_LAYOUT_MISMATCH/);
});

async function partialTemporaryResource(recoveryDir, onPartial) {
  const directory = await mkdtemp(join(recoveryDir, ".tsx-lvgl-live-partition-"));
  await chmod(directory, 0o700);
  const path = join(directory, "partition-table.bin");
  onPartial({ directory, path });
  await writeFile(path, Buffer.alloc(0), { mode: 0o600 });
  return { directory, path };
}

function physicalOptions(testFixture, overrides = {}) {
  return {
    execute: true,
    dryRun: false,
    preflightOnly: false,
    target: TARGET,
    port: "/dev/cu.test",
    recoveryDir: testFixture.recoveryDir,
    esptoolPython: process.execPath,
    artifact: testFixture.profile.artifact,
    descriptor: testFixture.profile.descriptorPath,
    baud: 115200,
    resetMode: "watchdog-reset",
    ...overrides,
  };
}

test("setup failure removes partial secure temporary resources before any command", async (t) => {
  const testFixture = await fixture(t);
  const commands = [];
  const capture = async (command) => {
    commands.push([...command]);
    return fakeOutput(command, testFixture.artifactSize);
  };

  await assert.rejects(runReload(physicalOptions(testFixture, { resetMode: "erase-flash" }), {
    root: testFixture.root,
    capture,
    recoveryContextLoader: async () => testFixture.context,
    temporaryFileFactory: partialTemporaryResource,
  }), /reset mode/);
  assert.deepEqual(commands.filter((command) => command[0] !== "git"), []);
  assert.equal((await readdir(testFixture.recoveryDir)).some((name) => name.startsWith(".tsx-lvgl-live-partition-")), false);
  assert.equal((await readdir(testFixture.recoveryDir)).some((name) => name.startsWith("operation-app-install-")), false);
});

test("operation-log setup failure logs terminal failure and removes its temporary resource", async (t) => {
  const testFixture = await fixture(t);
  const commands = [];
  const capture = async (command) => {
    commands.push([...command]);
    return fakeOutput(command, testFixture.artifactSize);
  };
  const operationLogFactory = async ({ context, onCreated }) => {
    const logPath = join(context.recoveryDir, "operation-app-install-injected.md");
    await writeFile(logPath, "# partial setup\n", { mode: 0o600 });
    onCreated(logPath);
    throw new Error("injected operation-log setup failure");
  };

  await assert.rejects(runReload(physicalOptions(testFixture), {
    root: testFixture.root,
    capture,
    recoveryContextLoader: async () => testFixture.context,
    temporaryFileFactory: partialTemporaryResource,
    operationLogFactory,
  }), /injected operation-log setup failure/);
  assert.deepEqual(commands.filter((command) => command[0] !== "git"), []);
  assert.equal((await readdir(testFixture.recoveryDir)).some((name) => name.startsWith(".tsx-lvgl-live-partition-")), false);
  const log = await readFile(join(testFixture.recoveryDir, "operation-app-install-injected.md"), "utf8");
  assert.match(log, /FAIL\/UNKNOWN — injected operation-log setup failure/);
});
