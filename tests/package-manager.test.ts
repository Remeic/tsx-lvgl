import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const packageManager = require(resolve(process.cwd(), "packages/sdk/dist/package-manager.js")) as {
  buildInstallInvocation: (selection: {
    name: "npm" | "pnpm" | "yarn" | "bun";
    command: string;
    prefixArgs: readonly string[];
  }, hasNpmLock: boolean) => { command: string; args: readonly string[] };
  resolvePackageManager: (
    root: string,
    packageJson: Readonly<Record<string, unknown>>,
    environment?: Readonly<Record<string, string | undefined>>,
  ) => { name: "npm" | "pnpm" | "yarn" | "bun"; command: string; prefixArgs: readonly string[] };
};

test("package manager selection honors package.json, invocation and lockfile seams", () => {
  const root = mkdtempSync(join(tmpdir(), "tsx-lvgl-package-manager-"));
  try {
    assert.deepEqual(
      packageManager.resolvePackageManager(root, { packageManager: "pnpm@10.0.0" }, {}),
      { name: "pnpm", command: "pnpm", prefixArgs: [] },
    );
    const yarn = packageManager.resolvePackageManager(
      root,
      {},
      { npm_config_user_agent: "  yarn/1.22.22 node/v24.19.0  ", npm_execpath: "/opt/yarn/bin/yarn.js" },
    );
    assert.deepEqual(yarn, { name: "yarn", command: process.execPath, prefixArgs: ["/opt/yarn/bin/yarn.js"] });
    const pnpmFromAgentOnly = packageManager.resolvePackageManager(
      root,
      {},
      { npm_config_user_agent: "pnpm/10.0.0" },
    );
    assert.deepEqual(pnpmFromAgentOnly, { name: "pnpm", command: "pnpm", prefixArgs: [] });
    const pnpmFromWhitespaceAgentOnly = packageManager.resolvePackageManager(
      root,
      {},
      { npm_config_user_agent: "  pnpm/10.0.0  " },
    );
    assert.deepEqual(pnpmFromWhitespaceAgentOnly, { name: "pnpm", command: "pnpm", prefixArgs: [] });
    const bun = packageManager.resolvePackageManager(
      root,
      {},
      { npm_config_user_agent: "bun/1.3.14 npm/? node/v24.3.0", npm_execpath: "/opt/bun/bin/bun" },
    );
    assert.deepEqual(bun, { name: "bun", command: "/opt/bun/bin/bun", prefixArgs: [] });
    const pnpmFromExecPath = packageManager.resolvePackageManager(
      root,
      {},
      { npm_execpath: "/opt/pnpm/bin/pnpm.cjs" },
    );
    assert.deepEqual(pnpmFromExecPath, { name: "pnpm", command: process.execPath, prefixArgs: ["/opt/pnpm/bin/pnpm.cjs"] });
    const npmFromExecPath = packageManager.resolvePackageManager(
      root,
      {},
      { npm_execpath: "/opt/npm/bin/npm-cli.js" },
    );
    assert.deepEqual(npmFromExecPath, { name: "npm", command: process.execPath, prefixArgs: ["/opt/npm/bin/npm-cli.js"] });
    const configuredWithForeignExecPath = packageManager.resolvePackageManager(
      root,
      { packageManager: "pnpm@10.0.0" },
      { npm_execpath: "/opt/npm/bin/npm-cli.js" },
    );
    assert.deepEqual(configuredWithForeignExecPath, { name: "pnpm", command: "pnpm", prefixArgs: [] });

    assert.deepEqual(packageManager.resolvePackageManager(root, {}, {}), { name: "npm", command: "npm", prefixArgs: [] });
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    assert.equal(packageManager.resolvePackageManager(root, {}, {}).name, "pnpm");
    rmSync(join(root, "pnpm-lock.yaml"));
    writeFileSync(join(root, "yarn.lock"), "\n");
    assert.equal(packageManager.resolvePackageManager(root, {}, {}).name, "yarn");
    rmSync(join(root, "yarn.lock"));
    writeFileSync(join(root, "bun.lock"), "\n");
    writeFileSync(join(root, "bun.lockb"), "\n");
    assert.equal(packageManager.resolvePackageManager(root, {}, {}).name, "bun");
    rmSync(join(root, "bun.lock"));
    rmSync(join(root, "bun.lockb"));
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    assert.equal(packageManager.resolvePackageManager(root, {}, {}).name, "npm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package manager selection rejects ambiguous and unsupported configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "tsx-lvgl-package-manager-"));
  try {
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    writeFileSync(join(root, "yarn.lock"), "\n");
    assert.throws(
      () => packageManager.resolvePackageManager(root, {}, {}),
      (error: { code?: string; message?: string }) =>
        error.code === "PACKAGE_MANAGER_AMBIGUOUS"
        && error.message === "multiple package-manager lockfiles found: yarn, npm",
    );
    for (const value of [null, 42, "", " ", "deno@2"]) {
      assert.throws(
        () => packageManager.resolvePackageManager(root, { packageManager: value }, {}),
        (error: { code?: string; message?: string }) =>
          error.code === "PACKAGE_MANAGER_UNSUPPORTED"
          && (
            value === "deno@2"
              ? error.message === "unsupported package manager: deno@2"
              : error.message === "packageManager must name npm, pnpm, yarn or bun"
        ),
      );
    }
    assert.throws(
      () => packageManager.resolvePackageManager(root, { packageManager: "yarn@4.5.0" }, {}),
      (error: { code?: string; message?: string }) =>
        error.code === "PACKAGE_MANAGER_UNSUPPORTED"
        && error.message === "Yarn Berry (v2+) is not supported; use Yarn Classic (v1) or configure node_modules linking",
    );
    assert.throws(
      () => packageManager.resolvePackageManager(root, {}, { npm_config_user_agent: "yarn/4.5.0 node/v24.19.0" }),
      (error: { code?: string; message?: string }) =>
        error.code === "PACKAGE_MANAGER_UNSUPPORTED"
        && error.message === "Yarn Berry (v2+) is not supported; use Yarn Classic (v1) or configure node_modules linking",
    );
    rmSync(join(root, "package-lock.json"));
    rmSync(join(root, "yarn.lock"));
    writeFileSync(join(root, ".yarnrc.yml"), "nodeLinker: pnp\n");
    assert.throws(
      () => packageManager.resolvePackageManager(root, { packageManager: "yarn" }, {}),
      (error: { code?: string; message?: string }) =>
        error.code === "PACKAGE_MANAGER_UNSUPPORTED"
        && error.message === "Yarn Berry (v2+) is not supported; use Yarn Classic (v1) or configure node_modules linking",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install invocation uses manager-specific flags without leaking npm lock handling", () => {
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "npm", command: "npm", prefixArgs: [] }, true),
    {
      command: "npm",
      args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", "--package-lock=false"],
    },
  );
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "npm", command: "npm", prefixArgs: [] }, false),
    { command: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"] },
  );
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "pnpm", command: "pnpm", prefixArgs: [] }, true),
    { command: "pnpm", args: ["install", "--ignore-scripts", "--offline", "--no-frozen-lockfile"] },
  );
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "yarn", command: "yarn", prefixArgs: [] }, false),
    { command: "yarn", args: ["install", "--ignore-scripts"] },
  );
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "bun", command: "bun", prefixArgs: [] }, false),
    { command: "bun", args: ["install", "--ignore-scripts"] },
  );
  assert.equal(existsSync(resolve(process.cwd(), "packages/sdk/dist/package-manager.js")), true);
});
