import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";

import { compileTsxBundle, type BundleOutput } from "@tsx-lvgl/bundler";
import { runHeadless, type HeadlessResult } from "./headless.js";
import {
  DEFAULT_BOARD_ID,
  LOCK_FORMAT_VERSION,
  SDK_PACKAGE_NAME,
} from "./metadata.js";
import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";
import { runDoctor, type DoctorResult } from "./doctor.js";
import { NODE_ENGINE_RANGE, validateNodeEngine } from "./node-engine.js";
import { buildInstallInvocation, resolvePackageManager } from "./package-manager.js";
import { withInstallTransaction } from "./install-transaction.js";
import ts from "typescript";

export interface ProjectConfig {
  readonly version: 1;
  readonly entry: string;
  readonly bundleId: string;
  readonly boardId: string;
  readonly generation: number;
}

export interface FrameworkArtifact {
  readonly file: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface FrameworkLock {
  readonly formatVersion: 1;
  readonly package: typeof SDK_PACKAGE_NAME;
  readonly version: string;
  readonly sourceSha: string;
  readonly artifact: FrameworkArtifact;
}

export interface Project {
  readonly root: string;
  readonly config: ProjectConfig;
  readonly lock: FrameworkLock;
  readonly artifactPath: string;
  readonly entryPath: string;
}

export interface BuildResult {
  readonly bundle: BundleOutput;
  readonly codePath: string;
  readonly manifestPath: string;
}

export interface CheckResult {
  readonly files: readonly string[];
}

export interface DevResult extends HeadlessResult {
  readonly bundleId: string;
}

interface PackProvenance {
  readonly formatVersion: 1;
  readonly packageName: typeof SDK_PACKAGE_NAME;
  readonly version: string;
  readonly sourceSha: string;
  readonly sourceDirty: false;
}

interface SourcePackResult {
  readonly artifactPath: string;
  readonly packageName: typeof SDK_PACKAGE_NAME;
  readonly version: string;
  readonly sourceSha: string;
  readonly sourceDirty: boolean;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface InstalledSdkPackRuntime {
  exists(path: string): boolean;
  makeTemporaryDirectory(prefix: string): string;
  remove(path: string): void;
  run(command: string, args: readonly string[], cwd: string): { readonly status: number | null; readonly stdout: string };
}

export const DEFAULT_INSTALLED_SDK_PACK_RUNTIME: InstalledSdkPackRuntime = {
  exists: existsSync,
  makeTemporaryDirectory: mkdtempSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  run: (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
    return { status: result.status, stdout: result.stdout };
  },
};

export async function createProject(
  target: string,
  artifactArgument?: string,
): Promise<{ readonly root: string; readonly lock: FrameworkLock }> {
  const root = resolve(target);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new CliError(DIAGNOSTIC_CODES.PROJECT_EXISTS, "target directory is not empty");
  }

  mkdirSync(root, { recursive: true });
  const appName = appNameFromRoot(root);
  writeText(root, "tsx-lvgl.json", `${JSON.stringify({
    version: 1,
    entry: "src/App.tsx",
    bundleId: "app",
    boardId: DEFAULT_BOARD_ID,
    generation: 1,
  }, null, 2)}\n`);
  writeText(root, "src/App.tsx", `import { Screen, Text, type VNode } from "@tsx-lvgl/sdk";\n\nexport default function App(): VNode {\n  return (\n    <Screen>\n      <Text text="Hello TSX-LVGL" />\n    </Screen>\n  );\n}\n`);
  writeText(root, "tsconfig.json", `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      jsx: "react-jsx",
      jsxImportSource: SDK_PACKAGE_NAME,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["src/**/*.ts", "src/**/*.tsx"],
  }, null, 2)}\n`);
  writeText(root, "package.json", `${JSON.stringify({
    name: appName,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: {
      node: NODE_ENGINE_RANGE,
    },
    scripts: {
      sync: "tsx-lvgl sync",
      update: "tsx-lvgl update",
      dev: "tsx-lvgl dev",
      check: "tsx-lvgl check",
      build: "tsx-lvgl build",
      doctor: "tsx-lvgl doctor",
    },
    dependencies: {},
  }, null, 2)}\n`);
  writeText(root, ".gitignore", "node_modules/\nbuild/\n");
  writeText(root, "AGENTS.md", consumerAgentsTemplate());

  const generatedArtifact = artifactArgument === undefined;
  const artifactPath = generatedArtifact ? packInstalledSdk() : resolve(artifactArgument);
  try {
    return await withInstallTransaction(root, async () => {
      const lock = installArtifactIntoProject(root, artifactPath);
      await installLockedArtifact(root, lock);
      return { root, lock };
    });
  } finally {
    if (generatedArtifact) rmSync(dirname(artifactPath), { recursive: true, force: true });
  }
}

export async function syncProject(root: string): Promise<{ readonly lock: FrameworkLock }> {
  const project = readProjectFiles(root);
  verifyArtifact(project);
  return withInstallTransaction(project.root, async () => {
    await installLockedArtifact(project.root, project.lock);
    return { lock: project.lock };
  });
}

export async function updateProject(root: string, explicitSource?: string): Promise<{ readonly lock: FrameworkLock }> {
  const projectRoot = resolve(root);
  const sourceRoot = resolveFrameworkSource(explicitSource);
  const tempRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tsx-lvgl-update-"));
  try {
    const packScript = join(sourceRoot, "scripts", "pack-sdk.mjs");
    const packed = spawnSync(process.execPath, [packScript, "--out", tempRoot, "--json"], {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (packed.status !== 0) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_PACK_FAILED, "framework source SDK packaging failed");
    }
    const metadata = parseSourcePackResult(packed.stdout);
    if (metadata.sourceDirty) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_DIRTY, "framework source checkout has uncommitted changes");
    }
    return await withInstallTransaction(projectRoot, async () => {
      const lock = installArtifactIntoProject(projectRoot, metadata.artifactPath, metadata);
      await installLockedArtifact(projectRoot, lock);
      return { lock };
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function checkProject(root: string): CheckResult {
  const project = verifyProject(root);
  const files = typecheckProject(project.root);
  return { files };
}

export function buildProject(root: string): BuildResult {
  const project = verifyProject(root);
  typecheckProject(project.root);
  const bundle = compileProject(project);
  const outputRoot = join(project.root, "build");
  mkdirSync(outputRoot, { recursive: true });
  const codePath = join(outputRoot, `${project.config.bundleId}.g${project.config.generation}.js`);
  const manifestPath = join(outputRoot, `${project.config.bundleId}.g${project.config.generation}.manifest.json`);
  writeFileSync(codePath, bundle.code, "ascii");
  writeFileSync(manifestPath, `${JSON.stringify(bundle.manifest, null, 2)}\n`, "utf8");
  return {
    bundle,
    codePath: relative(project.root, codePath),
    manifestPath: relative(project.root, manifestPath),
  };
}

export async function devProject(root: string): Promise<DevResult> {
  const project = verifyProject(root);
  typecheckProject(project.root);
  const bundle = compileProject(project);
  try {
    const result = await runHeadless(
      { manifest: bundle.manifest, source: bundle.bytes },
      project.config.boardId,
    );
    return { ...result, bundleId: project.config.bundleId };
  } catch (error) {
    throw new CliError(DIAGNOSTIC_CODES.DEV_FAILED, error instanceof Error ? error.message : String(error));
  }
}

export function doctorProject(
  root: string,
  { nodeVersion = process.versions.node }: { readonly nodeVersion?: string } = {},
): DoctorResult {
  const projectRoot = resolve(root);
  let config: ProjectConfig | undefined;
  let lock: FrameworkLock | undefined;
  return runDoctor({
    config: () => {
      config = readProjectConfig(projectRoot);
      return "tsx-lvgl.json is valid";
    },
    lock: () => {
      lock = readFrameworkLock(projectRoot);
      return "framework.lock.json is valid";
    },
    artifact: () => {
      if (lock === undefined || config === undefined) throw new CliError(DIAGNOSTIC_CODES.LOCK_INVALID, "cannot inspect artifact without a valid lock");
      verifyArtifact({ artifactPath: resolveArtifactPath(projectRoot, lock), lock });
      return "artifact digest and byte length match";
    },
    package: () => {
      if (lock === undefined) throw new CliError(DIAGNOSTIC_CODES.LOCK_INVALID, "cannot inspect package without a valid lock");
      verifyPackageDependency(projectRoot, lock);
      return "package.json uses the project-local artifact";
    },
    installation: () => {
      if (lock === undefined) throw new CliError(DIAGNOSTIC_CODES.LOCK_INVALID, "cannot inspect installation without a valid lock");
      verifyInstalledSdk(projectRoot, lock);
      return "installed SDK matches the lock";
    },
    portability: () => {
      verifyPortableConfig(projectRoot);
      return "portable config contains no source checkout path or workspace alias";
    },
    consumerNodeEngine: () => validateNodeEngine(readJson(join(projectRoot, "package.json"), DIAGNOSTIC_CODES.PACKAGE_INVALID), nodeVersion),
    sdkNodeEngine: () => validateInstalledSdkNodeEngine(projectRoot, nodeVersion),
  });
}

export function readProjectFiles(root: string): Project {
  const projectRoot = resolve(root);
  const config = readProjectConfig(projectRoot);
  const lock = readFrameworkLock(projectRoot);
  const artifactPath = resolveArtifactPath(projectRoot, lock);
  const entryPath = resolveEntryPath(projectRoot, config);
  return { root: projectRoot, config, lock, artifactPath, entryPath };
}

export function verifyProject(root: string): Project {
  const project = readProjectFiles(root);
  verifyArtifact(project);
  verifyPackageDependency(project.root, project.lock);
  verifyInstalledSdk(project.root, project.lock);
  verifyPortableConfig(project.root);
  return project;
}

function readProjectConfig(root: string): ProjectConfig {
  const filePath = join(root, "tsx-lvgl.json");
  if (!existsSync(filePath)) throw new CliError(DIAGNOSTIC_CODES.CONFIG_NOT_FOUND, "tsx-lvgl.json is missing");
  const value = readJson(filePath, DIAGNOSTIC_CODES.CONFIG_INVALID);
  if (value.version !== 1 || typeof value.entry !== "string" || typeof value.bundleId !== "string") {
    throw new CliError(DIAGNOSTIC_CODES.CONFIG_INVALID, "tsx-lvgl.json must declare version, entry and bundleId");
  }
  const boardId = typeof value.boardId === "string" ? value.boardId : DEFAULT_BOARD_ID;
  const generation = value.generation === undefined ? 1 : value.generation;
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new CliError(DIAGNOSTIC_CODES.CONFIG_INVALID, "generation must be a positive safe integer");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.bundleId)) {
    throw new CliError(DIAGNOSTIC_CODES.CONFIG_INVALID, "bundleId must contain only letters, numbers, dot, underscore or hyphen");
  }
  return {
    version: 1,
    entry: value.entry,
    bundleId: value.bundleId,
    boardId,
    generation,
  };
}

function readFrameworkLock(root: string): FrameworkLock {
  const filePath = join(root, ".tsx-lvgl", "framework.lock.json");
  if (!existsSync(filePath)) throw new CliError(DIAGNOSTIC_CODES.LOCK_NOT_FOUND, "framework.lock.json is missing");
  const value = readJson(filePath, DIAGNOSTIC_CODES.LOCK_INVALID);
  const artifact = isRecord(value.artifact) ? value.artifact : {};
  if (
    value.formatVersion !== LOCK_FORMAT_VERSION
    || value.package !== SDK_PACKAGE_NAME
    || typeof value.version !== "string"
    || !/^[0-9a-f]{40}$/.test(String(value.sourceSha))
    || typeof artifact.file !== "string"
    || typeof artifact.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || !Number.isSafeInteger(artifact.byteLength)
    || artifact.byteLength <= 0
  ) {
    throw new CliError(DIAGNOSTIC_CODES.LOCK_INVALID, "framework.lock.json has an invalid provenance or artifact record");
  }
  if (isAbsolute(artifact.file) || !artifact.file.startsWith(".tsx-lvgl/artifacts/")) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "framework artifact path must stay inside .tsx-lvgl/artifacts");
  }
  return {
    formatVersion: 1,
    package: SDK_PACKAGE_NAME,
    version: value.version,
    sourceSha: String(value.sourceSha),
    artifact: {
      file: artifact.file,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
    },
  };
}

function resolveArtifactPath(root: string, lock: FrameworkLock): string {
  return resolve(root, lock.artifact.file);
}

function resolveEntryPath(root: string, config: ProjectConfig): string {
  if (isAbsolute(config.entry)) throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "entry must be project-relative");
  const entryPath = resolve(root, config.entry);
  if (!entryPath.startsWith(`${root}${sep}`)) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "entry must stay inside the project");
  }
  if (!existsSync(entryPath)) throw new CliError(DIAGNOSTIC_CODES.CONFIG_INVALID, `entry does not exist: ${config.entry}`);
  return entryPath;
}

function verifyArtifact(project: Pick<Project, "artifactPath" | "lock">): void {
  if (!existsSync(project.artifactPath)) {
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "framework artifact is missing");
  }
  const bytes = readFileSync(project.artifactPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const byteLength = statSync(project.artifactPath).size;
  if (digest !== project.lock.artifact.sha256 || byteLength !== project.lock.artifact.byteLength) {
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH, "framework artifact digest or byte length does not match the lock");
  }
}

function verifyPackageDependency(root: string, lock: FrameworkLock): void {
  const value = readJson(join(root, "package.json"), DIAGNOSTIC_CODES.PACKAGE_INVALID);
  const dependencies = isRecord(value.dependencies) ? value.dependencies : {};
  const expected = `file:${lock.artifact.file}`;
  if (dependencies[SDK_PACKAGE_NAME] !== expected) {
    throw new CliError(DIAGNOSTIC_CODES.PACKAGE_INVALID, "package.json must pin @tsx-lvgl/sdk to the locked local artifact");
  }
  if (value.workspaces !== undefined || isRecord(value.compilerOptions) || isRecord(value.paths)) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "consumer package configuration must not expose workspace aliases");
  }
}

function verifyInstalledSdk(root: string, lock: FrameworkLock): void {
  const installedRoot = join(root, "node_modules", "@tsx-lvgl", "sdk");
  const packagePath = join(installedRoot, "package.json");
  const provenancePath = join(installedRoot, "provenance.json");
  if (!existsSync(packagePath) || !existsSync(provenancePath)) {
    throw new CliError(DIAGNOSTIC_CODES.PACKAGE_NOT_INSTALLED, "the locked SDK artifact is not installed");
  }
  const packageValue = readJson(packagePath, DIAGNOSTIC_CODES.PACKAGE_NOT_INSTALLED);
  const provenance = readJson(provenancePath, DIAGNOSTIC_CODES.PACKAGE_NOT_INSTALLED);
  if (packageValue.name !== SDK_PACKAGE_NAME || packageValue.version !== lock.version) {
    throw new CliError(DIAGNOSTIC_CODES.PACKAGE_NOT_INSTALLED, "installed SDK package identity does not match the lock");
  }
  if (
    provenance.packageName !== SDK_PACKAGE_NAME
    || provenance.version !== lock.version
    || provenance.sourceSha !== lock.sourceSha
    || provenance.sourceDirty !== false
  ) {
    throw new CliError(DIAGNOSTIC_CODES.PACKAGE_NOT_INSTALLED, "installed SDK provenance does not match the lock");
  }
}

function validateInstalledSdkNodeEngine(root: string, nodeVersion: string): string {
  const packagePath = join(root, "node_modules", "@tsx-lvgl", "sdk", "package.json");
  if (!existsSync(packagePath)) {
    throw new CliError(DIAGNOSTIC_CODES.PACKAGE_NOT_INSTALLED, "the locked SDK artifact is not installed");
  }
  return validateNodeEngine(readJson(packagePath, DIAGNOSTIC_CODES.PACKAGE_NOT_INSTALLED), nodeVersion, "sdk");
}

function verifyPortableConfig(root: string): void {
  const packageValue = readJson(join(root, "package.json"), DIAGNOSTIC_CODES.PACKAGE_INVALID);
  const dependency = isRecord(packageValue.dependencies) ? packageValue.dependencies[SDK_PACKAGE_NAME] : undefined;
  if (typeof dependency !== "string" || !dependency.startsWith("file:.tsx-lvgl/artifacts/")) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "consumer package dependency is not portable");
  }
  const configPath = join(root, "tsconfig.json");
  if (existsSync(configPath)) {
    const configText = readFileSync(configPath, "utf8");
    if (configText.includes("paths") || configText.includes("packages/*/src") || configText.includes("workspace")) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "tsconfig.json contains a workspace alias");
    }
  }
}

function typecheckProject(root: string): readonly string[] {
  const configPath = join(root, "tsconfig.json");
  if (!existsSync(configPath)) throw new CliError(DIAGNOSTIC_CODES.CONFIG_NOT_FOUND, "tsconfig.json is missing");
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error !== undefined) throw new CliError(DIAGNOSTIC_CODES.TYPECHECK_FAILED, formatDiagnostics([loaded.error], root));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
  if (parsed.errors.length > 0) throw new CliError(DIAGNOSTIC_CODES.TYPECHECK_FAILED, formatDiagnostics(parsed.errors, root));
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    ...(parsed.projectReferences === undefined ? {} : { projectReferences: parsed.projectReferences }),
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) throw new CliError(DIAGNOSTIC_CODES.TYPECHECK_FAILED, formatDiagnostics(diagnostics, root));
  return parsed.fileNames.map((fileName) => relative(root, fileName).split(sep).join("/"));
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[], root: string): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }).trim();
}

function compileProject(project: Project): BundleOutput {
  return compileTsxBundle({
    fileName: project.entryPath,
    source: readFileSync(project.entryPath, "utf8"),
    bundleId: project.config.bundleId,
    boardId: project.config.boardId,
    generation: project.config.generation,
    jsxImportSource: SDK_PACKAGE_NAME,
  });
}

function installArtifactIntoProject(root: string, artifactPath: string, metadata?: SourcePackResult): FrameworkLock {
  if (!existsSync(artifactPath)) throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "SDK artifact does not exist");
  const provenance = metadata === undefined ? readPackProvenance(artifactPath) : {
    formatVersion: 1 as const,
    packageName: metadata.packageName,
    version: metadata.version,
    sourceSha: metadata.sourceSha,
    sourceDirty: false as const,
  };
  if (
    provenance.sourceDirty !== false
    || provenance.packageName !== SDK_PACKAGE_NAME
    || !/^[0-9a-f]{40}$/.test(provenance.sourceSha)
  ) {
    if (provenance.sourceDirty !== false) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_DIRTY, "SDK artifact was packed from a dirty framework checkout");
    }
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH, "SDK artifact has invalid provenance");
  }
  const artifactFile = `tsx-lvgl-sdk-${provenance.version}.tgz`;
  const destination = join(root, ".tsx-lvgl", "artifacts", artifactFile);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(artifactPath, destination);
  const bytes = readFileSync(destination);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    formatVersion: 1,
    package: SDK_PACKAGE_NAME,
    version: provenance.version,
    sourceSha: provenance.sourceSha,
    artifact: {
      file: `.tsx-lvgl/artifacts/${artifactFile}`,
      sha256,
      byteLength: bytes.byteLength,
    },
  };
}

function writeSdkDependency(root: string, lock: FrameworkLock): void {
  const packagePath = join(root, "package.json");
  const value = readJson(packagePath, DIAGNOSTIC_CODES.PACKAGE_INVALID);
  const dependencies = isRecord(value.dependencies) ? { ...value.dependencies } : {};
  dependencies[SDK_PACKAGE_NAME] = `file:${lock.artifact.file}`;
  value.dependencies = dependencies;
  writeFileSync(packagePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileSync(
    join(root, ".tsx-lvgl", "framework.lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8",
  );
}

/** Keep create, sync and update on the same write-install-verify lifecycle. */
async function installLockedArtifact(root: string, lock: FrameworkLock): Promise<void> {
  writeSdkDependency(root, lock);
  await runPackageManagerInstall(root, resolveArtifactPath(root, lock));
  verifyInstalledSdk(root, lock);
}

async function runPackageManagerInstall(root: string, artifactPath: string): Promise<void> {
  const packageJson = readJson(join(root, "package.json"), DIAGNOSTIC_CODES.PACKAGE_INVALID);
  const packageManager = await resolvePackageManager(root, packageJson);
  const packageLockPath = join(root, "package-lock.json");
  const hasPackageLock = existsSync(packageLockPath);
  const bunCacheRoot = packageManager.name === "bun"
    ? mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tsx-lvgl-bun-cache-"))
    : undefined;
  const invocation = buildInstallInvocation(packageManager, hasPackageLock, bunCacheRoot);
  const result = (() => {
    try {
      return spawnSync(invocation.command, invocation.args, { cwd: root, encoding: "utf8", stdio: "pipe" });
    } finally {
      if (bunCacheRoot !== undefined) rmSync(bunCacheRoot, { recursive: true, force: true });
    }
  })();
  const errorCode = result.error !== undefined && "code" in result.error ? result.error.code : undefined;
  if (errorCode === "ENOENT") {
    throw new CliError(
      DIAGNOSTIC_CODES.PACKAGE_MANAGER_NOT_FOUND,
      `package manager is not installed: ${packageManager.name}`,
    );
  }
  if (result.status !== 0) {
    throw new CliError(
      DIAGNOSTIC_CODES.INSTALL_FAILED,
      `${packageManager.name} could not install the locked local SDK artifact`,
    );
  }
  if (packageManager.name === "npm" && hasPackageLock) synchronizePackageLock(packageLockPath, root, artifactPath);
}

/** Normalize npm lockfile records after a successful local-artifact install. */
export function synchronizePackageLock(packageLockPath: string, root: string, artifactPath: string): void {
  const packageLock = readJson(packageLockPath, DIAGNOSTIC_CODES.INSTALL_FAILED);
  const relativeArtifact = relative(root, artifactPath).split(sep).join("/");
  const integrity = `sha512-${createHash("sha512").update(readFileSync(artifactPath)).digest("base64")}`;
  const packages = isRecord(packageLock.packages) ? packageLock.packages : undefined;
  if (packages !== undefined) {
    const rootPackage = isRecord(packages[""]) ? packages[""] : undefined;
    const sdkPackage = isRecord(packages[`node_modules/${SDK_PACKAGE_NAME}`])
      ? packages[`node_modules/${SDK_PACKAGE_NAME}`]
      : undefined;
    if (rootPackage === undefined || sdkPackage === undefined) {
      throw new CliError(DIAGNOSTIC_CODES.INSTALL_FAILED, "package-lock.json has no installed SDK entry");
    }
    const rootDependencies = isRecord(rootPackage.dependencies) ? { ...rootPackage.dependencies } : {};
    rootDependencies[SDK_PACKAGE_NAME] = `file:${relativeArtifact}`;
    rootPackage.dependencies = rootDependencies;
    sdkPackage.resolved = `file:${relativeArtifact}`;
    sdkPackage.integrity = integrity;
  } else {
    const dependencies = isRecord(packageLock.dependencies) ? packageLock.dependencies : {};
    const sdkPackage = isRecord(dependencies[SDK_PACKAGE_NAME]) ? dependencies[SDK_PACKAGE_NAME] : undefined;
    if (sdkPackage === undefined) {
      throw new CliError(DIAGNOSTIC_CODES.INSTALL_FAILED, "package-lock.json has no installed SDK entry");
    }
    sdkPackage.resolved = `file:${relativeArtifact}`;
    sdkPackage.integrity = integrity;
  }
  writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`, "utf8");
}

function resolveFrameworkSource(explicitSource?: string): string {
  const configured = explicitSource
    ?? process.env.TSX_LVGL_SOURCE
    ?? readMachineSourceConfig();
  if (configured === undefined || configured.length === 0) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED, "set TSX_LVGL_SOURCE or configure ~/.config/tsx-lvgl/config.json");
  }
  const sourceRoot = resolve(configured);
  if (!existsSync(join(sourceRoot, "package.json")) || !existsSync(join(sourceRoot, "scripts", "pack-sdk.mjs"))) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED, "configured framework source is not a TSX-LVGL checkout");
  }
  return sourceRoot;
}

function readMachineSourceConfig(): string | undefined {
  const configPath = process.env.TSX_LVGL_CONFIG
    ?? join(process.env.HOME ?? "/tmp", ".config", "tsx-lvgl", "config.json");
  if (!existsSync(configPath)) return undefined;
  const value = readJson(configPath, DIAGNOSTIC_CODES.SOURCE_NOT_CONFIGURED);
  return typeof value.sourcePath === "string" ? value.sourcePath : undefined;
}

function parseSourcePackResult(stdout: string): SourcePackResult {
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (line === undefined) throw new CliError(DIAGNOSTIC_CODES.SOURCE_PACK_FAILED, "framework source returned no packaging metadata");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PACK_FAILED, "framework source returned malformed packaging metadata");
  }
  if (
    value.packageName !== SDK_PACKAGE_NAME
    || typeof value.artifactPath !== "string"
    || typeof value.version !== "string"
    || typeof value.sourceSha !== "string"
    || typeof value.sourceDirty !== "boolean"
    || typeof value.sha256 !== "string"
    || typeof value.byteLength !== "number"
  ) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PACK_FAILED, "framework source returned malformed packaging metadata");
  }
  return {
    artifactPath: value.artifactPath,
    packageName: SDK_PACKAGE_NAME,
    version: value.version,
    sourceSha: value.sourceSha,
    sourceDirty: value.sourceDirty,
    sha256: value.sha256,
    byteLength: value.byteLength,
  };
}

export function packInstalledSdk(
  sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  runtime: InstalledSdkPackRuntime = DEFAULT_INSTALLED_SDK_PACK_RUNTIME,
): string {
  const vendorCore = join(sdkRoot, "dist", "vendor", "core");
  if (!runtime.exists(vendorCore)) {
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "create needs --artifact when the CLI is not running from a packed SDK");
  }
  const outputRoot = runtime.makeTemporaryDirectory(join(process.env.TMPDIR ?? "/tmp", "tsx-lvgl-create-"));
  const args = ["pack", sdkRoot, "--ignore-scripts", "--json", "--pack-destination", outputRoot];
  const result = runtime.run("npm", args, sdkRoot);
  if (result.status !== 0) {
    runtime.remove(outputRoot);
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "the installed SDK could not be repacked");
  }
  let metadata: { filename: string } | undefined;
  try {
    metadata = JSON.parse(result.stdout).at(-1) as { filename: string } | undefined;
  } catch {
    metadata = undefined;
  }
  if (metadata === undefined) {
    runtime.remove(outputRoot);
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "the installed SDK returned no artifact");
  }
  return join(outputRoot, metadata.filename);
}

function readPackProvenance(artifactPath: string): PackProvenance {
  let dirtyArtifact = false;
  try {
    const archive = gunzipSync(readFileSync(artifactPath));
    let offset = 0;
    while (offset + 512 <= archive.byteLength) {
      const name = archive.subarray(offset, offset + 100).toString("utf8").replace(/\0.*$/, "");
      if (name.length === 0) break;
      const sizeText = archive.subarray(offset + 124, offset + 136).toString("utf8").replace(/\0.*$/, "").trim();
      const size = Number.parseInt(sizeText || "0", 8);
      const dataStart = offset + 512;
      if (name === "package/provenance.json") {
        const value = JSON.parse(archive.subarray(dataStart, dataStart + size).toString("utf8")) as Record<string, unknown>;
        if (
          value.formatVersion !== 1
          || value.packageName !== SDK_PACKAGE_NAME
          || typeof value.version !== "string"
          || typeof value.sourceSha !== "string"
          || typeof value.sourceDirty !== "boolean"
        ) throw new Error("invalid provenance");
        if (value.sourceDirty === true) {
          dirtyArtifact = true;
          break;
        }
        return {
          formatVersion: 1,
          packageName: SDK_PACKAGE_NAME,
          version: value.version,
          sourceSha: value.sourceSha,
          sourceDirty: false,
        };
      }
      offset = dataStart + Math.ceil(size / 512) * 512;
    }
  } catch {
    // The stable external error below intentionally does not expose archive internals.
  }
  if (dirtyArtifact) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_DIRTY, "SDK artifact was packed from a dirty framework checkout");
  }
  throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_DIGEST_MISMATCH, "SDK artifact does not contain valid provenance");
}

function writeText(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content, "utf8");
}

function appNameFromRoot(root: string): string {
  const candidate = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return candidate.length > 0 ? candidate : "tsx-lvgl-app";
}

function readJson(filePath: string, code: typeof DIAGNOSTIC_CODES[keyof typeof DIAGNOSTIC_CODES]): Record<string, any> {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, any>;
  } catch {
    throw new CliError(code, `cannot read ${basename(filePath)}`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function consumerAgentsTemplate(): string {
  const tick = String.fromCharCode(96);
  return [
    "# TSX-LVGL consumer application",
    "",
    `This application owns only the files under ${tick}src/${tick}, ${tick}tsx-lvgl.json${tick}, and the portable project metadata under ${tick}.tsx-lvgl/${tick}. The framework owns the SDK artifact; do not import ${tick}@tsx-lvgl/core${tick}, ${tick}@tsx-lvgl/runtime${tick}, ${tick}@tsx-lvgl/sensors${tick}, ${tick}@tsx-lvgl/bundler${tick}, or ${tick}@tsx-lvgl/device${tick} directly.`,
    "",
    "## Commands",
    "",
    `- ${tick}tsx-lvgl create <directory> --artifact <sdk.tgz>${tick} — scaffold a new app during bootstrap.`,
    `Use the package manager declared in ${tick}package.json${tick} or selected by the lockfile (npm, pnpm, Yarn Classic v1 or bun) to run these scripts. Yarn Berry/PnP is not supported by this CLI. For example: ${tick}<package-manager> run sync${tick}.`,
    `- ${tick}<package-manager> run sync${tick} — install the exact artifact already pinned by ${tick}.tsx-lvgl/framework.lock.json${tick}.`,
    `- ${tick}<package-manager> run update${tick} — explicitly package a configured framework checkout and update the pin.`,
    `- ${tick}<package-manager> run dev${tick} — run one deterministic headless kernel check.`,
    `- ${tick}<package-manager> run check${tick} — typecheck the app through the SDK facade.`,
    `- ${tick}<package-manager> run build${tick} — typecheck and emit the deterministic JavaScript bundle.`,
    `- ${tick}<package-manager> run doctor${tick} — inspect lock, artifact, installation, portability and engine diagnostics; append ${tick}-- --json${tick} for machine output.`,
    "",
    `The source checkout path, when needed for ${tick}update${tick}, is machine configuration only (${tick}TSX_LVGL_SOURCE${tick} or ${tick}~/.config/tsx-lvgl/config.json${tick}). It must never appear in app source, ${tick}package.json${tick}, the package-manager lockfile, or the committed framework lock. Updates are explicit; ${tick}dev${tick} and ${tick}build${tick} never upgrade the framework.`,
    "",
    "Safe operations stop at the host/package seam. A successful check, build or headless dev run is not simulator evidence and none of those results proves physical display, touch, reset, flashing or recovery readiness. Hardware work remains a separately authorized, guarded operation.",
    "",
  ].join("\n");
}
