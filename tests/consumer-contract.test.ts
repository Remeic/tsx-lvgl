import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("consumer contract works from a self-contained npm-pack artifact outside the workspace", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-consumer-contract-"));
  const packRoot = join(sandbox, "pack");
  const metadata = runJson(
    process.execPath,
    [join(repoRoot, "scripts/pack-sdk.mjs"), "--out", packRoot, "--json"],
    repoRoot,
  );
  const artifactPath = String(metadata.artifactPath);
  assert.ok(existsSync(artifactPath));

  const bootstrapRoot = join(sandbox, "bootstrap");
  mkdirSync(bootstrapRoot, { recursive: true });
  writeFileSync(
    join(sandbox, "bootstrap-package.json"),
    JSON.stringify({ name: "tsx-lvgl-contract-bootstrap", private: true, type: "module" }),
  );
  copyFileSync(join(sandbox, "bootstrap-package.json"), join(bootstrapRoot, "package.json"));
  run("npm", [
    "install",
    "--prefix",
    bootstrapRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    artifactPath,
  ], repoRoot);

  const cliPath = join(bootstrapRoot, "node_modules/@tsx-lvgl/sdk/dist/cli.js");
  const appRoot = join(sandbox, "tiltballs-like-app");
  const created = runJson(process.execPath, [cliPath, "create", appRoot, "--artifact", artifactPath, "--json"], sandbox);
  assert.equal(created.code, "CREATE_OK");
  const selfSeededRoot = join(sandbox, "self-seeded-app");
  const selfSeeded = runJson(process.execPath, [cliPath, "create", selfSeededRoot, "--json"], sandbox);
  assert.equal(selfSeeded.code, "CREATE_OK");

  const sync = runJson(process.execPath, [join(appRoot, "node_modules/@tsx-lvgl/sdk/dist/cli.js"), "sync", "--", "--json"], appRoot);
  assert.equal(sync.code, "SYNC_OK");
  const update = runJson(process.execPath, [cliPath, "update", "--source", repoRoot, "--json"], appRoot);
  assert.equal(update.code, "UPDATE_OK");
  assert.equal(update.sourceSha, metadata.sourceSha);
  const updatedPackageLock = JSON.parse(readFileSync(join(appRoot, "package-lock.json"), "utf8")) as {
    name?: string;
    version?: string;
    packages: Record<string, { dependencies?: Record<string, string>; resolved?: string }>;
  };
  const updatedRootPackage = updatedPackageLock.packages[""]!;
  const updatedSdkPackage = updatedPackageLock.packages["node_modules/@tsx-lvgl/sdk"]! as {
    version?: string;
    resolved?: string;
    integrity?: string;
  };
  assert.equal(
    updatedRootPackage.dependencies?.["@tsx-lvgl/sdk"],
    "file:.tsx-lvgl/artifacts/tsx-lvgl-sdk-0.1.0.tgz",
  );
  assert.equal(
    updatedSdkPackage.resolved,
    "file:.tsx-lvgl/artifacts/tsx-lvgl-sdk-0.1.0.tgz",
  );

  const v1Lock = {
    name: updatedPackageLock.name,
    version: updatedPackageLock.version,
    lockfileVersion: 1,
    requires: true,
    dependencies: {
      "@tsx-lvgl/sdk": {
        version: updatedSdkPackage.version,
        resolved: updatedSdkPackage.resolved,
        integrity: updatedSdkPackage.integrity,
      },
    },
  };
  writeFileSync(join(appRoot, "package-lock.json"), `${JSON.stringify(v1Lock, null, 2)}\n`);
  const v1Sync = runJson(process.execPath, [join(appRoot, "node_modules/@tsx-lvgl/sdk/dist/cli.js"), "sync", "--json"], appRoot);
  assert.equal(v1Sync.code, "SYNC_OK");
  const synchronizedV1Lock = JSON.parse(readFileSync(join(appRoot, "package-lock.json"), "utf8")) as {
    lockfileVersion: number;
    dependencies: Record<string, { resolved?: string }>;
  };
  assert.equal(synchronizedV1Lock.lockfileVersion, 1);
  assert.equal(
    synchronizedV1Lock.dependencies["@tsx-lvgl/sdk"]?.resolved,
    "file:.tsx-lvgl/artifacts/tsx-lvgl-sdk-0.1.0.tgz",
  );

  const dirtySource = join(sandbox, "dirty-framework");
  mkdirSync(join(dirtySource, "scripts"), { recursive: true });
  writeFileSync(join(dirtySource, "package.json"), "{\"private\":true}\n");
  const dirtyMetadata = {
    ...metadata,
    sourceSha: "0000000000000000000000000000000000000000",
    sourceDirty: true,
  };
  writeFileSync(
    join(dirtySource, "scripts/pack-sdk.mjs"),
    `console.log(${JSON.stringify(JSON.stringify(dirtyMetadata))});\n`,
  );
  const dirtyUpdate = runFailure(
    process.execPath,
    [cliPath, "update", "--source", dirtySource, "--json"],
    appRoot,
  );
  assert.equal(dirtyUpdate.code, "SOURCE_DIRTY");

  const dirtyExtractRoot = join(sandbox, "dirty-artifact-extract");
  mkdirSync(dirtyExtractRoot, { recursive: true });
  run("tar", ["-xzf", artifactPath, "-C", dirtyExtractRoot], sandbox);
  const dirtyProvenancePath = join(dirtyExtractRoot, "package/provenance.json");
  const dirtyProvenance = JSON.parse(readFileSync(dirtyProvenancePath, "utf8")) as Record<string, unknown>;
  dirtyProvenance.sourceDirty = true;
  writeFileSync(dirtyProvenancePath, `${JSON.stringify(dirtyProvenance, null, 2)}\n`);
  const dirtyPackRoot = join(sandbox, "dirty-artifact-pack");
  mkdirSync(dirtyPackRoot, { recursive: true });
  const dirtyPacked = JSON.parse(run("npm", [
    "pack",
    join(dirtyExtractRoot, "package"),
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    dirtyPackRoot,
  ], sandbox)) as Array<{ filename: string }>;
  const dirtyArtifact = join(dirtyPackRoot, dirtyPacked[0]!.filename);
  const dirtyCreate = runFailure(
    process.execPath,
    [cliPath, "create", join(sandbox, "dirty-artifact-app"), "--artifact", dirtyArtifact, "--json"],
    sandbox,
  );
  assert.equal(dirtyCreate.code, "SOURCE_DIRTY");

  const packageBeforeFailedSync = readFileSync(join(appRoot, "package.json"), "utf8");
  const frameworkLockBeforeFailedSync = readFileSync(join(appRoot, ".tsx-lvgl/framework.lock.json"), "utf8");
  writeFileSync(join(appRoot, "yarn.lock"), "\n");
  const failedSync = runFailure(
    process.execPath,
    [join(appRoot, "node_modules/@tsx-lvgl/sdk/dist/cli.js"), "sync", "--json"],
    appRoot,
    { npm_config_user_agent: undefined, npm_execpath: undefined },
  );
  assert.equal(failedSync.code, "PACKAGE_MANAGER_AMBIGUOUS");
  assert.equal(readFileSync(join(appRoot, "package.json"), "utf8"), packageBeforeFailedSync);
  assert.equal(readFileSync(join(appRoot, ".tsx-lvgl/framework.lock.json"), "utf8"), frameworkLockBeforeFailedSync);
  assert.equal(existsSync(join(appRoot, "node_modules/@tsx-lvgl/sdk/provenance.json")), true);
  rmSync(join(appRoot, "yarn.lock"), { force: true });

  const nodePackageLockPath = join(appRoot, "node_modules/.package-lock.json");
  const sdkBinPath = join(appRoot, "node_modules/.bin/tsx-lvgl");
  const nodePackageLockBeforeFailedInstall = readFileSync(nodePackageLockPath);
  const sdkBinTargetBeforeFailedInstall = readlinkSync(sdkBinPath);
  const provenanceBeforeFailedInstall = readFileSync(join(appRoot, "node_modules/@tsx-lvgl/sdk/provenance.json"));
  const fakeBinRoot = join(sandbox, "fake-package-manager-bin");
  mkdirSync(fakeBinRoot, { recursive: true });
  const fakeNpmPath = join(fakeBinRoot, "npm");
  writeFileSync(fakeNpmPath, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync("package-lock.json", "mutated by failed install\\n");
fs.writeFileSync("node_modules/.package-lock.json", "mutated by failed install\\n");
fs.rmSync("node_modules/.bin/tsx-lvgl", { force: true });
fs.writeFileSync("node_modules/.bin/tsx-lvgl", "mutated by failed install\\n");
fs.mkdirSync("node_modules/@tsx-lvgl/sdk", { recursive: true });
fs.writeFileSync("node_modules/@tsx-lvgl/sdk/provenance.json", "mutated by failed install\\n");
process.exit(17);
`);
  chmodSync(fakeNpmPath, 0o755);
  const failedInstall = runFailure(
    process.execPath,
    [join(appRoot, "node_modules/@tsx-lvgl/sdk/dist/cli.js"), "sync", "--json"],
    appRoot,
    {
      PATH: `${fakeBinRoot}${delimiter}${process.env.PATH ?? ""}`,
      npm_config_user_agent: undefined,
      npm_execpath: undefined,
    },
  );
  assert.equal(failedInstall.code, "INSTALL_FAILED");
  assert.equal(readFileSync(join(appRoot, "package.json"), "utf8"), packageBeforeFailedSync);
  assert.equal(readFileSync(join(appRoot, ".tsx-lvgl/framework.lock.json"), "utf8"), frameworkLockBeforeFailedSync);
  assert.deepEqual(readFileSync(nodePackageLockPath), nodePackageLockBeforeFailedInstall);
  assert.equal(lstatSync(sdkBinPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(sdkBinPath), sdkBinTargetBeforeFailedInstall);
  assert.deepEqual(
    readFileSync(join(appRoot, "node_modules/@tsx-lvgl/sdk/provenance.json")),
    provenanceBeforeFailedInstall,
  );

  const parseFailure = runFailure(
    process.execPath,
    [cliPath, "check", "--unknown-option", "--json"],
    appRoot,
  );
  assert.equal(parseFailure.code, "UNSUPPORTED_COMMAND");

  const check = runJson(process.execPath, [cliPath, "check", "--json"], appRoot);
  assert.equal(check.code, "CHECK_OK");
  assert.deepEqual(check.files, ["src/App.tsx"]);
  const build = runJson(process.execPath, [cliPath, "build", "--json"], appRoot);
  assert.equal(build.code, "BUILD_OK");
  assert.equal(typeof build.sha256, "string");
  const consumerBundle = readFileSync(join(appRoot, String(build.codePath)), "utf8");
  assert.match(consumerBundle, /@tsx-lvgl\/sdk\/jsx-runtime/);
  for (const internalSpecifier of ["@tsx-lvgl/core", "@tsx-lvgl/runtime", "@tsx-lvgl/sensors", "@tsx-lvgl/bundler", "@tsx-lvgl/device"]) {
    assert.equal(consumerBundle.includes(internalSpecifier), false, `consumer bundle must not emit ${internalSpecifier}`);
  }
  const dev = runJson(process.execPath, [cliPath, "dev", "--json"], appRoot);
  assert.equal(dev.code, "DEV_OK");
  assert.deepEqual(dev.texts, ["Hello TSX-LVGL"]);
  const doctor = runJson(process.execPath, [cliPath, "doctor", "--json"], appRoot);
  assert.equal(doctor.code, "DOCTOR_OK");

  const packageJson = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    workspaces?: unknown;
  };
  assert.deepEqual(Object.keys(packageJson.dependencies), ["@tsx-lvgl/sdk"]);
  assert.equal(packageJson.workspaces, undefined);
  assert.equal(existsSync(join(appRoot, "node_modules/@tsx-lvgl/core")), false);

  const portableFiles = [
    "package.json",
    "package-lock.json",
    "tsx-lvgl.json",
    "tsconfig.json",
    ".tsx-lvgl/framework.lock.json",
    "AGENTS.md",
  ];
  for (const file of portableFiles) {
    const content = readFileSync(join(appRoot, file), "utf8");
    assert.equal(content.includes(repoRoot), false, `${file} must not contain the framework checkout path`);
    assert.equal(content.includes("packages/*/src"), false, `${file} must not contain a source alias`);
  }

  const lock = JSON.parse(readFileSync(join(appRoot, ".tsx-lvgl/framework.lock.json"), "utf8")) as {
    sourceSha: string;
    artifact: { file: string; sha256: string; byteLength: number };
  };
  const lockedArtifact = readFileSync(join(appRoot, lock.artifact.file));
  assert.match(lock.sourceSha, /^[0-9a-f]{40}$/);
  assert.equal(lock.artifact.byteLength, lockedArtifact.byteLength);
  assert.equal(lock.artifact.sha256, createHash("sha256").update(lockedArtifact).digest("hex"));
  assert.equal(basename(lock.artifact.file), "tsx-lvgl-sdk-0.1.0.tgz");
});

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function runJson(command: string, args: readonly string[], cwd: string): Record<string, any> {
  const stdout = run(command, args, cwd).trim();
  return JSON.parse(stdout) as Record<string, any>;
}

function runFailure(
  command: string,
  args: readonly string[],
  cwd: string,
  environment?: Readonly<Record<string, string | undefined>>,
): Record<string, any> {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe", env });
  assert.notEqual(result.status, 0, `${command} unexpectedly succeeded`);
  return JSON.parse(result.stderr.trim()) as Record<string, any>;
}
