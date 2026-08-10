import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileTsxBundle, type BundleOutput } from "@tsx-lvgl/bundler";
import { runHeadless, type HeadlessResult } from "./headless.js";
import { doctorDevicePort, runDeviceDev, type DeviceDevResult } from "./device-dev.js";
import {
  DEFAULT_BOARD_ID,
  LOCK_FORMAT_VERSION,
  SDK_PACKAGE_NAME,
} from "./metadata.js";
import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";
import { runDoctor, type DoctorResult } from "./doctor.js";
import { NODE_ENGINE_RANGE, validateNodeEngine } from "./node-engine.js";
import { recoverInterruptedInstall, withInstallTransaction } from "./install-transaction.js";
import {
  DEFAULT_ARTIFACT_STORE,
  recoverProjectArtifactState,
  type ArtifactStore,
  validateArtifactReference,
} from "./artifact-store.js";
import { DEFAULT_INSTALL_EXECUTOR, type InstallExecutor } from "./install-executor.js";
import type { FrameworkLock } from "./framework-lock.js";
import { DEFAULT_SOURCE_PACK_ADAPTER, type SourcePackAdapter } from "./source-pack.js";
import ts from "typescript";

export interface ProjectConfig {
  readonly version: 1;
  readonly entry: string;
  readonly bundleId: string;
  readonly boardId: string;
  readonly generation: number;
}

export type { FrameworkArtifact, FrameworkLock } from "./framework-lock.js";
export { synchronizePackageLock } from "./install-executor.js";

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
  readonly device?: DeviceDevResult;
}

export interface InstalledSdkPackRuntime {
  exists(path: string): boolean;
  makeTemporaryDirectory(prefix: string): string;
  remove(path: string): void;
  run(command: string, args: readonly string[], cwd: string): { readonly status: number | null; readonly stdout: string };
}

/**
 * The narrow external seams used by create/update. Keeping them explicit lets
 * the lifecycle be exercised in-process while package-manager contracts keep
 * validating the production implementations separately.
 */
export interface ProjectLifecycleAdapters {
  readonly artifactStore: ArtifactStore;
  readonly installExecutor: InstallExecutor;
  readonly sourcePackAdapter: SourcePackAdapter;
}

export const DEFAULT_PROJECT_LIFECYCLE_ADAPTERS: ProjectLifecycleAdapters = {
  artifactStore: DEFAULT_ARTIFACT_STORE,
  installExecutor: DEFAULT_INSTALL_EXECUTOR,
  sourcePackAdapter: DEFAULT_SOURCE_PACK_ADAPTER,
};

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
  packArtifact: () => string = packInstalledSdk,
  adapters: ProjectLifecycleAdapters = DEFAULT_PROJECT_LIFECYCLE_ADAPTERS,
): Promise<{ readonly root: string; readonly lock: FrameworkLock }> {
  const root = resolve(target);
  const targetExisted = existsSync(root);
  if (targetExisted) recoverConsumerProjectState(root);
  if (targetExisted && readdirSync(root).length > 0) {
    throw new CliError(DIAGNOSTIC_CODES.PROJECT_EXISTS, "target directory is not empty");
  }

  let cleanupGeneratedArtifact: () => void = () => {};
  try {
    scaffoldProject(root);
    const artifactPath = artifactArgument === undefined
      ? packArtifact()
      : resolve(artifactArgument);
    if (artifactArgument === undefined) {
      cleanupGeneratedArtifact = () => rmSync(dirname(artifactPath), { recursive: true, force: true });
    }
    const installArtifact = artifactPath;
    return await withInstallTransaction(root, async () => {
      const lock = adapters.artifactStore.install(root, installArtifact);
      await installLockedArtifact(root, lock, adapters);
      return { root, lock };
    });
  } catch (error) {
    restoreCreateTarget(root, targetExisted);
    throw error;
  } finally {
    cleanupGeneratedArtifact();
  }
}

export async function syncProject(root: string): Promise<{ readonly lock: FrameworkLock }> {
  const projectRoot = resolve(root);
  recoverConsumerProjectState(projectRoot);
  const project = readProjectFiles(projectRoot);
  DEFAULT_ARTIFACT_STORE.verify(project.artifactPath, project.lock);
  return withInstallTransaction(project.root, async () => {
    await installLockedArtifact(project.root, project.lock);
    return { lock: project.lock };
  });
}

export async function updateProject(
  root: string,
  explicitSource?: string,
  adapters: ProjectLifecycleAdapters = DEFAULT_PROJECT_LIFECYCLE_ADAPTERS,
): Promise<{ readonly lock: FrameworkLock }> {
  const projectRoot = resolve(root);
  recoverConsumerProjectState(projectRoot);
  const project = readProjectFiles(projectRoot);
  const sourceRoot = adapters.sourcePackAdapter.resolveSource(explicitSource);
  const tempRoot = adapters.sourcePackAdapter.createOutputDirectory();
  try {
    const metadata = adapters.sourcePackAdapter.pack(sourceRoot, tempRoot);
    if (metadata.sourceDirty) {
      throw new CliError(DIAGNOSTIC_CODES.SOURCE_DIRTY, "framework source checkout has uncommitted changes");
    }
    return await withInstallTransaction(project.root, async () => {
      const lock = adapters.artifactStore.install(project.root, metadata.artifactPath, metadata);
      await installLockedArtifact(project.root, lock, adapters);
      return { lock };
    });
  } finally {
    adapters.sourcePackAdapter.removeOutputDirectory(tempRoot);
  }
}

export function checkProject(root: string): CheckResult {
  recoverConsumerProjectState(root);
  const project = verifyProject(root);
  const files = typecheckProject(project.root);
  return { files };
}

export function buildProject(root: string): BuildResult {
  recoverConsumerProjectState(root);
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

export async function devProject(
  root: string,
  options: { readonly device: boolean; readonly port?: string } = { device: false },
): Promise<DevResult> {
  recoverConsumerProjectState(root);
  const project = verifyProject(root);
  typecheckProject(project.root);
  const bundle = compileProject(project);
  try {
    if (options.device) {
      const device = await runDeviceDev(bundle, options.port ?? "");
      return { bundleId: project.config.bundleId, generation: device.generation, texts: [], logs: [], device };
    }
    const result = await runHeadless(
      { manifest: bundle.manifest, source: bundle.bytes },
      project.config.boardId,
    );
    return { ...result, bundleId: project.config.bundleId };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(DIAGNOSTIC_CODES.DEV_FAILED, error instanceof Error ? error.message : String(error));
  }
}

export function doctorProject(
  root: string,
  {
    nodeVersion = process.versions.node,
    device = false,
    port,
  }: { readonly nodeVersion?: string; readonly device?: boolean; readonly port?: string } = {},
): DoctorResult {
  const projectRoot = resolve(root);
  recoverConsumerProjectState(projectRoot);
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
      if (lock === undefined) throw new CliError(DIAGNOSTIC_CODES.LOCK_INVALID, "cannot inspect artifact without a valid lock");
      DEFAULT_ARTIFACT_STORE.verify(DEFAULT_ARTIFACT_STORE.resolve(projectRoot, lock), lock);
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
    ...(device ? { devicePort: () => doctorDevicePort(port ?? "") } : {}),
  });
}

export function readProjectFiles(root: string): Project {
  const projectRoot = resolve(root);
  recoverConsumerProjectState(projectRoot);
  const config = readProjectConfig(projectRoot);
  const lock = readFrameworkLock(projectRoot);
  const artifactPath = DEFAULT_ARTIFACT_STORE.resolve(projectRoot, lock);
  const entryPath = resolveEntryPath(projectRoot, config);
  return { root: projectRoot, config, lock, artifactPath, entryPath };
}

export function verifyProject(root: string): Project {
  const project = readProjectFiles(root);
  DEFAULT_ARTIFACT_STORE.verify(project.artifactPath, project.lock);
  verifyPackageDependency(project.root, project.lock);
  verifyInstalledSdk(project.root, project.lock);
  verifyPortableConfig(project.root);
  return project;
}

/** Recover durable install and artifact swap state before a public project read. */
function recoverConsumerProjectState(root: string): void {
  const projectRoot = resolve(root);
  recoverInterruptedInstall(projectRoot);
  recoverProjectArtifactState(projectRoot);
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
  validateArtifactReference(artifact.file);
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

function resolveEntryPath(root: string, config: ProjectConfig): string {
  if (isAbsolute(config.entry)) throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "entry must be project-relative");
  const entryPath = resolve(root, config.entry);
  if (!entryPath.startsWith(`${root}${sep}`)) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "entry must stay inside the project");
  }
  if (!existsSync(entryPath)) throw new CliError(DIAGNOSTIC_CODES.CONFIG_INVALID, `entry does not exist: ${config.entry}`);
  return entryPath;
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

/** Keep create, sync and update on the same write-install-verify lifecycle. */
async function installLockedArtifact(
  root: string,
  lock: FrameworkLock,
  adapters: Pick<ProjectLifecycleAdapters, "artifactStore" | "installExecutor"> = DEFAULT_PROJECT_LIFECYCLE_ADAPTERS,
): Promise<void> {
  await adapters.installExecutor.install(
    root,
    lock,
    adapters.artifactStore.resolve(root, lock),
    () => verifyInstalledSdk(root, lock),
  );
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

function writeText(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content, "utf8");
}

function scaffoldProject(root: string): void {
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
    engines: { node: NODE_ENGINE_RANGE },
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
}

function restoreCreateTarget(root: string, targetExisted: boolean): void {
  rmSync(root, { recursive: true, force: true });
  if (targetExisted) mkdirSync(root, { recursive: true });
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
