import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface PackageManagerCase {
  readonly name: "pnpm" | "yarn" | "bun";
  readonly command: string;
  readonly args: (appRoot: string, sourceRoot: string) => readonly string[];
}

const managerDefinitions: readonly PackageManagerCase[] = [
  {
    name: "pnpm",
    command: "pnpm",
    args: (appRoot: string, sourceRoot: string) => ["--dir", appRoot, "run", "update", "--", "--source", sourceRoot, "--json"],
  },
  {
    name: "yarn",
    command: "yarn",
    args: (appRoot: string, sourceRoot: string) => ["--cwd", appRoot, "run", "update", "--", "--source", sourceRoot, "--json"],
  },
  {
    name: "bun",
    command: "bun",
    args: (appRoot: string, sourceRoot: string) => ["run", "--cwd", appRoot, "update", "--", "--source", sourceRoot, "--json"],
  },
];

const managerCases = managerDefinitions.filter(({ name, command }) => name === "yarn" ? isClassicYarn() : isAvailable(command));

test(
  "consumer update works through each available non-npm package manager",
  { skip: managerCases.length === 0 ? "no supported non-npm package manager is installed" : false },
  () => {
    const sandbox = mkdtempSync(join(tmpdir(), "tsx-lvgl-package-manager-contract-"));
    const packRoot = join(sandbox, "pack");
    const metadata = runJson(
      process.execPath,
      [join(repoRoot, "scripts/pack-sdk.mjs"), "--out", packRoot, "--json"],
      repoRoot,
      {
        npm_execpath: "/opt/pnpm/bin/pnpm.cjs",
        npm_config_user_agent: "pnpm/10.0.0 node/v24.19.0",
      },
    );
    assert.equal(metadata.sourceDirty, false);
    assert.ok(existsSync(String(metadata.artifactPath)));

    const bootstrapRoot = join(sandbox, "bootstrap");
    mkdirSync(bootstrapRoot, { recursive: true });
    writeBootstrapPackage(bootstrapRoot);
    run("npm", [
      "install",
      "--prefix",
      bootstrapRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      String(metadata.artifactPath),
    ], repoRoot);
    const cliPath = join(bootstrapRoot, "node_modules/@tsx-lvgl/sdk/dist/cli.js");

    for (const manager of managerCases) {
      const appRoot = join(sandbox, `${manager.name}-app`);
      runJson(process.execPath, [cliPath, "create", appRoot, "--artifact", String(metadata.artifactPath), "--json"], sandbox);
      const result = spawnSync(manager.command, manager.args(appRoot, repoRoot), {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      });
      assert.equal(result.status, 0, `${manager.name} failed:\n${result.stdout}\n${result.stderr}`);
      const output = lastJsonLine(result.stdout);
      assert.equal(output.code, "UPDATE_OK", `${manager.name} did not emit UPDATE_OK`);
      assert.equal(output.sourceSha, metadata.sourceSha);
    }
  },
);

function isAvailable(command: string): boolean {
  return spawnSync(command, ["--version"], { encoding: "utf8", stdio: "ignore" }).status === 0;
}

function isClassicYarn(): boolean {
  const result = spawnSync("yarn", ["--version"], { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) return false;
  return Number.parseInt(result.stdout.trim().split(".")[0] ?? "0", 10) === 1;
}

function writeBootstrapPackage(root: string): void {
  const packagePath = join(root, "package.json");
  const packageJson = {
    name: "tsx-lvgl-package-manager-bootstrap",
    private: true,
    type: "module",
  };
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function run(command: string, args: readonly string[], cwd: string, environment?: Readonly<Record<string, string>>): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
  });
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function runJson(
  command: string,
  args: readonly string[],
  cwd: string,
  environment?: Readonly<Record<string, string>>,
): Record<string, any> {
  return JSON.parse(run(command, args, cwd, environment).trim()) as Record<string, any>;
}

function lastJsonLine(stdout: string): Record<string, any> {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      return JSON.parse(line) as Record<string, any>;
    } catch {
      // Package managers may print informational lines around the CLI result.
    }
  }
  throw new Error(`no JSON result in package-manager output: ${stdout}`);
}
