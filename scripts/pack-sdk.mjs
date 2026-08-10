import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_ROOT = resolve(ROOT, "packages/sdk");
const PACKAGE_NAMES = ["core", "sensors", "runtime", "bundler", "device"];
const VALIDATION_GIT_SHA_ENV = "TSX_LVGL_VALIDATION_GIT_SHA";
const VALIDATION_GIT_STATE_ENV = "TSX_LVGL_VALIDATION_GIT_STATE";
const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function usage() {
  return `Usage:
  node scripts/pack-sdk.mjs [--out <directory>] [--json]

The command builds a self-contained npm-pack artifact for @tsx-lvgl/sdk.
`;
}

function parseArgs(argv) {
  let out = resolve(ROOT, "build/sdk-artifacts");
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--out") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error("--out requires a value");
      out = resolve(value);
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return { out, json };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr ?? ""}`.trim());
  }
  return result;
}

function readPackage(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

function gitValue(args) {
  const result = run("git", args, { cwd: ROOT, stdio: "pipe" });
  return result.stdout.trim();
}

function collectSourceProvenance(environment = process.env) {
  try {
    return {
      sourceSha: gitValue(["rev-parse", "HEAD"]),
      sourceDirty: gitValue(["status", "--porcelain"]).length > 0,
    };
  } catch (error) {
    if (!isGitMetadataUnavailable(error)) throw error;
    return sourceProvenanceFromEnvironment(environment);
  }
}

function isGitMetadataUnavailable(error) {
  return /not a git repository/i.test(error instanceof Error ? error.message : String(error));
}

function sourceProvenanceFromEnvironment(environment) {
  const sourceSha = requiredEnvironmentValue(VALIDATION_GIT_SHA_ENV, environment[VALIDATION_GIT_SHA_ENV]);
  if (!FULL_GIT_SHA_PATTERN.test(sourceSha)) {
    throw new Error(`${VALIDATION_GIT_SHA_ENV} must be a full hexadecimal object ID`);
  }
  const sourceState = requiredEnvironmentValue(VALIDATION_GIT_STATE_ENV, environment[VALIDATION_GIT_STATE_ENV]);
  if (sourceState !== "clean" && sourceState !== "dirty") {
    throw new Error(`${VALIDATION_GIT_STATE_ENV} must be clean or dirty`);
  }
  return { sourceSha, sourceDirty: sourceState === "dirty" };
}

function requiredEnvironmentValue(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required when Git metadata is unavailable`);
  }
  return value.trim();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sdkPackage = readPackage(SDK_ROOT);
  if (sdkPackage.private !== true) throw new Error("@tsx-lvgl/sdk must remain private; npm pack is the only distribution path");
  if (sdkPackage.name !== "@tsx-lvgl/sdk") throw new Error("unexpected SDK package name");

  buildSdk();
  const stagingRoot = mkdtempSync(join(tmpdir(), "tsx-lvgl-sdk-pack-"));
  try {
    const stagingDist = resolve(stagingRoot, "dist");
    cpSync(resolve(SDK_ROOT, "dist"), stagingDist, { recursive: true });
    removeBuildInfo(stagingDist);
    cpSync(resolve(SDK_ROOT, "README.md"), resolve(stagingRoot, "README.md"));
    for (const name of PACKAGE_NAMES) copyInternalDist(name, stagingDist);
    copyPackageManagerDetector(stagingDist);
    copySemver(stagingDist);
    copyTypeScript(stagingDist);
    rewriteInternalImports(stagingDist);

    const { sourceSha, sourceDirty: dirty } = collectSourceProvenance();
    const provenance = {
      formatVersion: 1,
      packageName: sdkPackage.name,
      version: sdkPackage.version,
      sourceSha,
      sourceDirty: dirty,
    };
    const portablePackage = { ...sdkPackage };
    delete portablePackage.dependencies;
    delete portablePackage.bundledDependencies;
    writeFileSync(resolve(stagingRoot, "package.json"), `${JSON.stringify(portablePackage, null, 2)}\n`, "utf8");
    writeFileSync(resolve(stagingRoot, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

    // The artifact boundary is intentionally npm-pack-compatible even when a
    // consumer invokes this script through pnpm, Yarn or Bun.
    const args = ["pack", stagingRoot, "--ignore-scripts", "--json", "--pack-destination", options.out];
    mkdirSync(options.out, { recursive: true });
    const packed = run("npm", args, { cwd: ROOT, stdio: "pipe" });
    const npmMetadata = JSON.parse(packed.stdout).at(-1);
    const artifactPath = resolve(options.out, npmMetadata.filename);
    const bytes = readFileSync(artifactPath);
    const result = {
      packageName: sdkPackage.name,
      version: sdkPackage.version,
      sourceSha,
      sourceDirty: dirty,
      artifactPath,
      filename: npmMetadata.filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    };
    if (options.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`pack-sdk: wrote ${artifactPath}`);
      console.log(`pack-sdk: ${result.byteLength} bytes sha256=${result.sha256}`);
      console.log(`pack-sdk: sourceSha=${sourceSha}`);
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function buildSdk() {
  const tscPath = resolve(ROOT, "node_modules/typescript/bin/tsc");
  if (!existsSync(tscPath)) throw new Error("missing root node_modules/typescript; run npm ci first");
  run(process.execPath, [tscPath, "-b", resolve(SDK_ROOT, "tsconfig.json"), "--force", "--pretty", "false"], {
    cwd: ROOT,
    stdio: "pipe",
  });
}

function copyInternalDist(name, stagingDist) {
  const sourceDist = resolve(ROOT, "packages", name, "dist");
  if (!existsSync(sourceDist)) throw new Error(`missing ${name}/dist; run npm run build first`);
  const destination = resolve(stagingDist, "vendor", name);
  cpSync(sourceDist, destination, { recursive: true });
  removeBuildInfo(destination);
}

function removeBuildInfo(root) {
  const buildInfo = resolve(root, "tsconfig.tsbuildinfo");
  if (existsSync(buildInfo)) rmSync(buildInfo, { force: true });
}

function copyTypeScript(stagingDist) {
  const sourceRoot = resolve(ROOT, "node_modules/typescript");
  if (!existsSync(sourceRoot)) throw new Error("missing root node_modules/typescript; run npm ci first");
  cpSync(sourceRoot, resolve(stagingDist, "vendor/typescript"), { recursive: true });
}

function copyPackageManagerDetector(stagingDist) {
  const sourceRoot = resolve(ROOT, "node_modules/package-manager-detector");
  if (!existsSync(resolve(sourceRoot, "dist"))) {
    throw new Error("missing package-manager-detector; run npm ci first");
  }
  const destination = resolve(stagingDist, "vendor/package-manager-detector");
  cpSync(resolve(sourceRoot, "dist"), resolve(destination, "dist"), { recursive: true });
  cpSync(resolve(sourceRoot, "LICENSE"), resolve(destination, "LICENSE"));
}

function copySemver(stagingDist) {
  const sourceRoot = resolve(ROOT, "node_modules/semver");
  if (!existsSync(sourceRoot)) {
    throw new Error("missing semver; run npm ci first");
  }
  cpSync(sourceRoot, resolve(stagingDist, "vendor/semver"), { recursive: true });
}

function rewriteInternalImports(stagingDist) {
  const replacements = {
    "@tsx-lvgl/core/jsx-runtime": ["core", "jsx-runtime.js"],
    "@tsx-lvgl/core": ["core", "index.js"],
    "@tsx-lvgl/runtime": ["runtime", "index.js"],
    "@tsx-lvgl/sensors": ["sensors", "index.js"],
    "@tsx-lvgl/bundler": ["bundler", "index.js"],
    "@tsx-lvgl/device": ["device", "index.js"],
    "package-manager-detector/detect": ["package-manager-detector", "dist", "detect.mjs"],
    "package-manager-detector/commands": ["package-manager-detector", "dist", "commands.mjs"],
    "package-manager-detector/constants": ["package-manager-detector", "dist", "constants.mjs"],
    semver: ["semver", "index.js"],
    typescript: ["typescript", "lib", "typescript.js"],
  };

  for (const filePath of walkFiles(stagingDist)) {
    if (!filePath.endsWith(".js") && !filePath.endsWith(".d.ts")) continue;
    if (filePath.includes(`${sep}vendor${sep}typescript${sep}`)) continue;
    let source = readFileSync(filePath, "utf8");
    for (const [specifier, targetParts] of Object.entries(replacements)) {
      const target = resolve(stagingDist, "vendor", ...targetParts);
      let replacement = relative(dirname(filePath), target).split(sep).join("/");
      if (!replacement.startsWith(".")) replacement = `./${replacement}`;
      const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      source = source.replace(
        new RegExp(`(from\\s*[\\\"'])${escapedSpecifier}([\\\"'])`, "g"),
        (_match, prefix, suffix) => `${prefix}${replacement}${suffix}`,
      );
      source = source.replace(
        new RegExp(`(import\\s*\\(\\s*[\\\"'])${escapedSpecifier}([\\\"'])`, "g"),
        (_match, prefix, suffix) => `${prefix}${replacement}${suffix}`,
      );
    }
    writeFileSync(filePath, source, "utf8");
  }
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(filePath));
    else files.push(filePath);
  }
  return files;
}

try {
  main();
} catch (error) {
  console.error(`pack-sdk: ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exitCode = 1;
}
