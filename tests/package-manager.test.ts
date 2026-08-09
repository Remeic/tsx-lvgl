import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";
type SupportedAgent = "npm" | "pnpm" | "pnpm@6" | "yarn" | "bun";
interface Selection {
  readonly name: PackageManagerName;
  readonly agent: SupportedAgent;
}

const require = createRequire(import.meta.url);
const packageManager = require(resolve(process.cwd(), "packages/sdk/dist/package-manager.js")) as {
  buildInstallInvocation: (
    selection: Selection,
    hasNpmLock: boolean,
    bunCacheDirectory?: string,
  ) => { command: string; args: readonly string[] };
  resolvePackageManager: (
    root: string,
    packageJson: Readonly<Record<string, unknown>>,
    context?: { readonly userAgent?: string | null },
  ) => Promise<Selection>;
};

test("package manager selection delegates package fields, invocation and lockfiles to the detector", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsx-lvgl-package-manager-"));
  try {
    writeFileSync(join(root, "package.json"), "{}\n");
    assert.deepEqual(
      await packageManager.resolvePackageManager(root, { packageManager: "pnpm@10.0.0" }, { userAgent: null }),
      { name: "pnpm", agent: "pnpm" },
    );
    assert.deepEqual(
      await packageManager.resolvePackageManager(root, { packageManager: "pnpm@6.35.1" }, { userAgent: null }),
      { name: "pnpm", agent: "pnpm@6" },
    );
    assert.deepEqual(
      await packageManager.resolvePackageManager(root, {}, { userAgent: "yarn" }),
      { name: "yarn", agent: "yarn" },
    );
    assert.deepEqual(
      await packageManager.resolvePackageManager(root, {}, { userAgent: "bun" }),
      { name: "bun", agent: "bun" },
    );
    assert.deepEqual(
      await packageManager.resolvePackageManager(root, {}, { userAgent: null }),
      { name: "npm", agent: "npm" },
    );

    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    assert.equal((await packageManager.resolvePackageManager(root, {}, { userAgent: null })).name, "pnpm");
    rmSync(join(root, "pnpm-lock.yaml"));
    writeFileSync(join(root, "yarn.lock"), "\n");
    assert.equal((await packageManager.resolvePackageManager(root, {}, { userAgent: null })).name, "yarn");
    rmSync(join(root, "yarn.lock"));
    writeFileSync(join(root, "bun.lock"), "\n");
    writeFileSync(join(root, "bun.lockb"), "\n");
    assert.equal((await packageManager.resolvePackageManager(root, {}, { userAgent: null })).name, "bun");
    rmSync(join(root, "bun.lock"));
    rmSync(join(root, "bun.lockb"));
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    assert.equal((await packageManager.resolvePackageManager(root, {}, { userAgent: null })).name, "npm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package manager selection preserves stable diagnostics around the detector", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsx-lvgl-package-manager-"));
  try {
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    writeFileSync(join(root, "yarn.lock"), "\n");
    await assert.rejects(
      packageManager.resolvePackageManager(root, {}, { userAgent: null }),
      (error: { code?: string; message?: string }) =>
        error.code === "PACKAGE_MANAGER_AMBIGUOUS"
        && error.message === "multiple package-manager lockfiles found: npm, yarn",
    );
    for (const value of [null, 42, "", " ", "deno@2"]) {
      await assert.rejects(
        packageManager.resolvePackageManager(root, { packageManager: value }, { userAgent: null }),
        (error: { code?: string; message?: string }) =>
          error.code === "PACKAGE_MANAGER_UNSUPPORTED"
          && (
            value === "deno@2"
              ? error.message === "unsupported package manager: deno@2"
              : error.message === "packageManager must name npm, pnpm, yarn or bun"
          ),
      );
    }
    await assert.rejects(
      packageManager.resolvePackageManager(root, { packageManager: "yarn@4.5.0" }, { userAgent: null }),
      (error: { code?: string; message?: string }) =>
        error.code === "PACKAGE_MANAGER_UNSUPPORTED"
        && error.message === "Yarn Berry (v2+) is not supported; use Yarn Classic (v1), npm, pnpm or Bun",
    );
    await assert.rejects(
      packageManager.resolvePackageManager(root, {}, { userAgent: "deno" }),
      (error: { code?: string; message?: string }) =>
        error.code === "PACKAGE_MANAGER_UNSUPPORTED"
        && error.message === "unsupported package manager: deno",
    );
    rmSync(join(root, "package-lock.json"));
    rmSync(join(root, "yarn.lock"));
    writeFileSync(join(root, ".yarnrc.yml"), "nodeLinker: pnp\n");
    await assert.rejects(
      packageManager.resolvePackageManager(root, { packageManager: "yarn" }, { userAgent: null }),
      (error: { code?: string; message?: string }) =>
        error.code === "PACKAGE_MANAGER_UNSUPPORTED"
        && error.message === "Yarn Berry (v2+) is not supported; use Yarn Classic (v1), npm, pnpm or Bun",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install invocation comes from the detector and adds only TSX-LVGL safety flags", () => {
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "npm", agent: "npm" }, true),
    {
      command: "npm",
      args: ["i", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", "--package-lock=false"],
    },
  );
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "npm", agent: "npm" }, false),
    { command: "npm", args: ["i", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"] },
  );
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "pnpm", agent: "pnpm" }, true),
    { command: "pnpm", args: ["i", "--ignore-scripts", "--offline", "--no-frozen-lockfile"] },
  );
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "pnpm", agent: "pnpm@6" }, false),
    { command: "pnpm", args: ["i", "--ignore-scripts", "--offline", "--no-frozen-lockfile"] },
  );
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "yarn", agent: "yarn" }, false),
    { command: "yarn", args: ["install", "--ignore-scripts"] },
  );
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "bun", agent: "bun" }, false, "/tmp/tsx-lvgl-bun-cache"),
    { command: "bun", args: ["install", "--ignore-scripts", "--cache-dir", "/tmp/tsx-lvgl-bun-cache"] },
  );
  assert.equal(existsSync(resolve(process.cwd(), "packages/sdk/dist/package-manager.js")), true);
});
