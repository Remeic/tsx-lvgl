import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";
type SupportedAgent = "npm" | "pnpm" | "pnpm@6" | "yarn" | "bun";
interface Selection {
  readonly name: PackageManagerName;
  readonly agent: SupportedAgent;
}

const packageManager = await import(new URL("../../packages/sdk/dist/package-manager.js", import.meta.url).href) as {
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
  const originalUserAgent = process.env.npm_config_user_agent;
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
      await packageManager.resolvePackageManager(root, { packageManager: "npm@11.0.0" }, { userAgent: null }),
      { name: "npm", agent: "npm" },
    );
    assert.deepEqual(
      await packageManager.resolvePackageManager(root, {}, { userAgent: "yarn" }),
      { name: "yarn", agent: "yarn" },
    );
    assert.deepEqual(
      await packageManager.resolvePackageManager(root, {}, { userAgent: "bun" }),
      { name: "bun", agent: "bun" },
    );
    process.env.npm_config_user_agent = "pnpm/10.0.0 npm/? node/v24.19.0";
    assert.deepEqual(
      await packageManager.resolvePackageManager(root, {}),
      { name: "pnpm", agent: "pnpm" },
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
    writeFileSync(join(root, ".yarnrc.yml"), "nodeLinker: pnp\n");
    await assert.rejects(
      packageManager.resolvePackageManager(root, {}, { userAgent: null }),
      (error: { code?: string }) => error.code === "PACKAGE_MANAGER_UNSUPPORTED",
    );
    rmSync(join(root, ".yarnrc.yml"));
    rmSync(join(root, "yarn.lock"));
    writeFileSync(join(root, "bun.lock"), "\n");
    writeFileSync(join(root, "bun.lockb"), "\n");
    assert.equal((await packageManager.resolvePackageManager(root, {}, { userAgent: null })).name, "bun");
    rmSync(join(root, "bun.lock"));
    rmSync(join(root, "bun.lockb"));
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    assert.equal((await packageManager.resolvePackageManager(root, {}, { userAgent: null })).name, "npm");
    rmSync(join(root, "package-lock.json"));
    writeFileSync(join(root, "deno.lock"), "{}\n");
    await assert.rejects(
      packageManager.resolvePackageManager(root, {}, { userAgent: null }),
      (error: { code?: string; message?: string }) =>
        error.code === "PACKAGE_MANAGER_UNSUPPORTED"
        && error.message === "unsupported package manager: deno",
    );
    rmSync(join(root, "deno.lock"));
    writeFileSync(join(root, "rush.json"), "{}\n");
    await assert.rejects(
      packageManager.resolvePackageManager(root, {}, { userAgent: null }),
      (error: { code?: string; message?: string }) =>
        error.code === "PACKAGE_MANAGER_UNSUPPORTED"
        && error.message === "unsupported package manager: pnpm-rush",
    );
  } finally {
    if (originalUserAgent === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = originalUserAgent;
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
    for (const value of [null, 42, "", " ", "deno@2", "unknown-pm@1"]) {
      await assert.rejects(
        packageManager.resolvePackageManager(root, { packageManager: value }, { userAgent: null }),
        (error: { code?: string; message?: string }) =>
          error.code === "PACKAGE_MANAGER_UNSUPPORTED"
          && (
            value === "deno@2" || value === "unknown-pm@1"
              ? error.message === `unsupported package manager: ${value}`
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
    assert.deepEqual(
      await packageManager.resolvePackageManager(root, { packageManager: "npm@11.0.0" }, { userAgent: null }),
      { name: "npm", agent: "npm" },
    );
    await assert.rejects(
      packageManager.resolvePackageManager(root, { packageManager: "yarn" }, { userAgent: null }),
      (error: { code?: string; message?: string }) =>
        error.code === "PACKAGE_MANAGER_UNSUPPORTED"
        && error.message === "Yarn Berry (v2+) is not supported; use Yarn Classic (v1), npm, pnpm or Bun",
    );
    rmSync(join(root, ".yarnrc.yml"));
    for (const marker of [".pnp.cjs", ".pnp.js", "node_modules/.yarn-state.yml"]) {
      const markerPath = join(root, marker);
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, "\n");
      await assert.rejects(
        packageManager.resolvePackageManager(root, {}, { userAgent: "npm" }),
        (error: { code?: string; message?: string }) =>
          error.code === "PACKAGE_MANAGER_UNSUPPORTED"
          && error.message === "Yarn Berry (v2+) is not supported; use Yarn Classic (v1), npm, pnpm or Bun",
      );
      rmSync(markerPath);
    }
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
    packageManager.buildInstallInvocation({ name: "yarn", agent: "yarn" }, false, "/tmp/ignored-bun-cache"),
    { command: "yarn", args: ["install", "--ignore-scripts"] },
  );
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "bun", agent: "bun" }, false, "/tmp/tsx-lvgl-bun-cache"),
    { command: "bun", args: ["install", "--ignore-scripts", "--cache-dir", "/tmp/tsx-lvgl-bun-cache"] },
  );
  assert.deepEqual(
    packageManager.buildInstallInvocation({ name: "bun", agent: "bun" }, false),
    { command: "bun", args: ["install", "--ignore-scripts"] },
  );
});
