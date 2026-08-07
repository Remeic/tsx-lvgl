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

export interface DoctorCheck {
  readonly code: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorResult {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

interface PackProvenance {
  readonly formatVersion: 1;
  readonly packageName: typeof SDK_PACKAGE_NAME;
  readonly version: string;
  readonly sourceSha: string;
  readonly sourceDirty?: boolean;
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

export function createProject(target: string, artifactArgument?: string): { readonly root: string; readonly lock: FrameworkLock } {
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
    const lock = installArtifactIntoProject(root, artifactPath);
    writeSdkDependency(root, lock);
    runNpmInstall(root, resolveArtifactPath(root, lock));
    verifyInstalledSdk(root, lock);
    return { root, lock };
  } finally {
    if (generatedArtifact) rmSync(dirname(artifactPath), { recursive: true, force: true });
  }
}

export function syncProject(root: string): { readonly lock: FrameworkLock } {
  const project = readProjectFiles(root);
  verifyArtifact(project);
  writeSdkDependency(project.root, project.lock);
  runNpmInstall(project.root, project.artifactPath);
  verifyInstalledSdk(project.root, project.lock);
  return { lock: project.lock };
}

export function updateProject(root: string, explicitSource?: string): { readonly lock: FrameworkLock } {
  const projectRoot = resolve(root);
  const sourceRoot = resolveFrameworkSource(explicitSource);
  const tempRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tsx-lvgl-update-"));
  try {
    const packScript = join(sourceRoot, "scripts", "pack-sdk.mjs");
    if (!existsSync(packScript)) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_PACK_FAILED, "configured framework source has no SDK pack script");
    }
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
    const lock = installArtifactIntoProject(projectRoot, metadata.artifactPath, metadata);
    writeSdkDependency(projectRoot, lock);
    runNpmInstall(projectRoot, resolveArtifactPath(projectRoot, lock));
    verifyInstalledSdk(projectRoot, lock);
    return { lock };
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

export function doctorProject(root: string): DoctorResult {
  const projectRoot = resolve(root);
  const checks: DoctorCheck[] = [];
  let config: ProjectConfig | undefined;
  let lock: FrameworkLock | undefined;

  const check = (code: string, action: () => string): void => {
    try {
      checks.push({ code, ok: true, detail: action() });
    } catch (error) {
      const cliError = error instanceof CliError ? error : new CliError("CHECK_FAILED", String(error));
      checks.push({ code: cliError.code, ok: false, detail: cliError.message });
    }
  };

  check(DIAGNOSTIC_CODES.CONFIG_NOT_FOUND, () => {
    config = readProjectConfig(projectRoot);
    return "tsx-lvgl.json is valid";
  });
  check(DIAGNOSTIC_CODES.LOCK_NOT_FOUND, () => {
    lock = readFrameworkLock(projectRoot);
    return "framework.lock.json is valid";
  });
  check(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, () => {
    if (lock === undefined || config === undefined) {
      throw new CliError(DIAGNOSTIC_CODES.LOCK_INVALID, "cannot inspect artifact without a valid lock");
    }
    verifyArtifact({ artifactPath: resolveArtifactPath(projectRoot, lock), lock });
    return "artifact digest and byte length match";
  });
  check(DIAGNOSTIC_CODES.PACKAGE_INVALID, () => {
    if (lock === undefined) throw new CliError(DIAGNOSTIC_CODES.LOCK_INVALID, "cannot inspect package without a valid lock");
    verifyPackageDependency(projectRoot, lock);
    return "package.json uses the project-local artifact";
  });
  check(DIAGNOSTIC_CODES.SDK_NOT_INSTALLED, () => {
    if (lock === undefined) throw new CliError(DIAGNOSTIC_CODES.LOCK_INVALID, "cannot inspect installation without a valid lock");
    verifyInstalledSdk(projectRoot, lock);
    return "installed SDK matches the lock";
  });
  check(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, () => {
    verifyPortableConfig(projectRoot);
    return "portable config contains no source checkout path or workspace alias";
  });
  check(DIAGNOSTIC_CODES.UNSUPPORTED_NODE, () => {
    const packageValue = readJson(join(projectRoot, "package.json"), DIAGNOSTIC_CODES.PACKAGE_INVALID);
    const engines = isRecord(packageValue.engines) ? packageValue.engines : {};
    const required = typeof engines.node === "string" ? engines.node : undefined;
    if (required !== undefined && required !== process.versions.node) {
      throw new CliError(DIAGNOSTIC_CODES.UNSUPPORTED_NODE, `Node ${process.versions.node} is outside the configured engine ${required}`);
    }
    return `Node ${process.versions.node}`;
  });

  return { ok: checks.every((entry) => entry.ok), checks };
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
  const artifactPath = resolve(root, lock.artifact.file);
  const expectedRoot = resolve(root, ".tsx-lvgl", "artifacts");
  if (!artifactPath.startsWith(`${expectedRoot}${sep}`)) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "framework artifact path escapes the project");
  }
  return artifactPath;
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
  if (provenance.packageName !== SDK_PACKAGE_NAME || provenance.version !== lock.version || provenance.sourceSha !== lock.sourceSha) {
    throw new CliError(DIAGNOSTIC_CODES.PACKAGE_NOT_INSTALLED, "installed SDK provenance does not match the lock");
  }
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
  try {
    return compileTsxBundle({
      fileName: project.entryPath,
      source: readFileSync(project.entryPath, "utf8"),
      bundleId: project.config.bundleId,
      boardId: project.config.boardId,
      generation: project.config.generation,
      jsxImportSource: SDK_PACKAGE_NAME,
    });
  } catch (error) {
    throw new CliError(DIAGNOSTIC_CODES.BUNDLE_FAILED, error instanceof Error ? error.message : String(error));
  }
}

function installArtifactIntoProject(root: string, artifactPath: string, metadata?: SourcePackResult): FrameworkLock {
  if (!existsSync(artifactPath)) throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "SDK artifact does not exist");
  const provenance = metadata === undefined ? readPackProvenance(artifactPath) : {
    formatVersion: 1 as const,
    packageName: metadata.packageName,
    version: metadata.version,
    sourceSha: metadata.sourceSha,
  };
  if (provenance.packageName !== SDK_PACKAGE_NAME || !/^[0-9a-f]{40}$/.test(provenance.sourceSha)) {
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

function runNpmInstall(root: string, artifactPath: string): void {
  const packageLockPath = join(root, "package-lock.json");
  const hasPackageLock = existsSync(packageLockPath);
  const installedSdkRoot = join(root, "node_modules", "@tsx-lvgl", "sdk");
  // npm keys a file dependency by its path and version. Remove the installed
  // package before sync/update so a same-version artifact with a new digest is
  // not incorrectly treated as already satisfied.
  rmSync(installedSdkRoot, { recursive: true, force: true });
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath === undefined ? "npm" : process.execPath;
  const baseArgs = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"];
  if (hasPackageLock) baseArgs.push("--package-lock=false");
  const args = npmExecPath === undefined ? baseArgs : [npmExecPath, ...baseArgs];
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new CliError(DIAGNOSTIC_CODES.INSTALL_FAILED, "npm could not install the locked local SDK artifact");
  }
  if (hasPackageLock) synchronizePackageLock(packageLockPath, root, artifactPath);
}

function synchronizePackageLock(packageLockPath: string, root: string, artifactPath: string): void {
  const packageLock = readJson(packageLockPath, DIAGNOSTIC_CODES.INSTALL_FAILED);
  const packages = isRecord(packageLock.packages) ? packageLock.packages : {};
  const rootPackage = isRecord(packages[""]) ? packages[""] : undefined;
  const sdkPackage = isRecord(packages[`node_modules/${SDK_PACKAGE_NAME}`])
    ? packages[`node_modules/${SDK_PACKAGE_NAME}`]
    : undefined;
  if (rootPackage === undefined || sdkPackage === undefined) {
    throw new CliError(DIAGNOSTIC_CODES.INSTALL_FAILED, "package-lock.json has no installed SDK entry");
  }
  const relativeArtifact = relative(root, artifactPath).split(sep).join("/");
  const rootDependencies = isRecord(rootPackage.dependencies) ? { ...rootPackage.dependencies } : {};
  rootDependencies[SDK_PACKAGE_NAME] = `file:${relativeArtifact}`;
  rootPackage.dependencies = rootDependencies;
  sdkPackage.resolved = `file:${relativeArtifact}`;
  sdkPackage.integrity = `sha512-${createHash("sha512").update(readFileSync(artifactPath)).digest("base64")}`;
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

function packInstalledSdk(): string {
  const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const vendorCore = join(sdkRoot, "dist", "vendor", "core");
  if (!existsSync(vendorCore)) {
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "create needs --artifact when the CLI is not running from a packed SDK");
  }
  const outputRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tsx-lvgl-create-"));
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath === undefined ? "npm" : process.execPath;
  const args = npmExecPath === undefined
    ? ["pack", sdkRoot, "--ignore-scripts", "--json", "--pack-destination", outputRoot]
    : [npmExecPath, "pack", sdkRoot, "--ignore-scripts", "--json", "--pack-destination", outputRoot];
  const result = spawnSync(command, args, { cwd: sdkRoot, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "the installed SDK could not be repacked");
  }
  let metadata: { filename: string } | undefined;
  try {
    metadata = JSON.parse(result.stdout).at(-1) as { filename: string } | undefined;
  } catch {
    metadata = undefined;
  }
  if (metadata === undefined) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw new CliError(DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND, "the installed SDK returned no artifact");
  }
  return join(outputRoot, metadata.filename);
}

function readPackProvenance(artifactPath: string): PackProvenance {
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
        ) throw new Error("invalid provenance");
        return {
          formatVersion: 1,
          packageName: SDK_PACKAGE_NAME,
          version: value.version,
          sourceSha: value.sourceSha,
          ...(typeof value.sourceDirty === "boolean" ? { sourceDirty: value.sourceDirty } : {}),
        };
      }
      offset = dataStart + Math.ceil(size / 512) * 512;
    }
  } catch {
    // The stable external error below intentionally does not expose archive internals.
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
    `- ${tick}npm run sync${tick} — install the exact artifact already pinned by ${tick}.tsx-lvgl/framework.lock.json${tick}.`,
    `- ${tick}npm run update${tick} — explicitly package a configured framework checkout and update the pin.`,
    `- ${tick}npm run dev${tick} — run one deterministic headless kernel check.`,
    `- ${tick}npm run check${tick} — typecheck the app through the SDK facade.`,
    `- ${tick}npm run build${tick} — typecheck and emit the deterministic JavaScript bundle.`,
    `- ${tick}npm run doctor${tick} — inspect lock, artifact, installation, portability and engine diagnostics; add ${tick}-- --json${tick} for machine output.`,
    "",
    `The source checkout path, when needed for ${tick}update${tick}, is machine configuration only (${tick}TSX_LVGL_SOURCE${tick} or ${tick}~/.config/tsx-lvgl/config.json${tick}). It must never appear in app source, ${tick}package.json${tick}, ${tick}package-lock.json${tick}, or the committed lock. Updates are explicit; ${tick}dev${tick} and ${tick}build${tick} never upgrade the framework.`,
    "",
    "Safe operations stop at the host/package seam. A successful check, build or headless dev run is not simulator evidence and none of those results proves physical display, touch, reset, flashing or recovery readiness. Hardware work remains a separately authorized, guarded operation.",
    "",
  ].join("\n");
}
