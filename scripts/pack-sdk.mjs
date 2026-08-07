import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_ROOT = resolve(ROOT, "packages/sdk");
const PACKAGE_NAMES = ["core", "sensors", "runtime", "bundler", "device"];

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
    throw new Error(`${command} ${args.join(" ")} failed`);
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sdkPackage = readPackage(SDK_ROOT);
  if (sdkPackage.private !== true) throw new Error("@tsx-lvgl/sdk must remain private; npm pack is the only distribution path");
  if (sdkPackage.name !== "@tsx-lvgl/sdk") throw new Error("unexpected SDK package name");

  const stagingRoot = mkdtempSync(join(tmpdir(), "tsx-lvgl-sdk-pack-"));
  try {
    const stagingDist = resolve(stagingRoot, "dist");
    cpSync(resolve(SDK_ROOT, "dist"), stagingDist, { recursive: true });
    removeBuildInfo(stagingDist);
    cpSync(resolve(SDK_ROOT, "README.md"), resolve(stagingRoot, "README.md"));
    for (const name of PACKAGE_NAMES) copyInternalDist(name, stagingDist);
    copyTypeScript(stagingDist);
    rewriteInternalImports(stagingDist);

    const sourceSha = gitValue(["rev-parse", "HEAD"]);
    const dirty = gitValue(["status", "--porcelain", "--untracked-files=no"]).length > 0;
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

    const npmExecPath = process.env.npm_execpath;
    const command = npmExecPath === undefined ? "npm" : process.execPath;
    const args = npmExecPath === undefined
      ? ["pack", stagingRoot, "--ignore-scripts", "--json", "--pack-destination", options.out]
      : [npmExecPath, "pack", stagingRoot, "--ignore-scripts", "--json", "--pack-destination", options.out];
    mkdirSync(options.out, { recursive: true });
    const packed = run(command, args, { cwd: ROOT, stdio: "pipe" });
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

function rewriteInternalImports(stagingDist) {
  const replacements = {
    "@tsx-lvgl/core/jsx-runtime": ["core", "jsx-runtime.js"],
    "@tsx-lvgl/core": ["core", "index.js"],
    "@tsx-lvgl/runtime": ["runtime", "index.js"],
    "@tsx-lvgl/sensors": ["sensors", "index.js"],
    "@tsx-lvgl/bundler": ["bundler", "index.js"],
    "@tsx-lvgl/device": ["device", "index.js"],
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
