import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";

export interface FileSnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes?: Buffer;
}

export interface InstallTransactionFs {
  exists(path: string): boolean;
  makeSiblingTemporaryDirectory(root: string, prefix: string): string;
  readFile(path: string): Buffer;
  copy(from: string, to: string): void;
  rename(from: string, to: string): void;
  remove(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
  makeDirectory(path: string): void;
  writeFile(path: string, bytes: Buffer): void;
  validateArtifactDirectory?(path: string): void;
}

export const DEFAULT_INSTALL_TRANSACTION_FS: InstallTransactionFs = {
  exists: existsSync,
  makeSiblingTemporaryDirectory: (root, prefix) => mkdtempSync(join(dirname(root), prefix)),
  readFile: readFileSync,
  copy: (from, to) => cpSync(from, to, { recursive: true, dereference: false }),
  rename: renameSync,
  remove: rmSync,
  makeDirectory: (path) => mkdirSync(path, { recursive: true }),
  writeFile: writeFileSync,
  validateArtifactDirectory: validateFlatArtifactDirectory,
};

const METADATA_PATHS = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  ".pnp.js",
  ".tsx-lvgl/framework.lock.json",
] as const;

const TRANSACTION_DIRECTORIES = [
  { path: "node_modules", move: true },
  { path: ".tsx-lvgl/artifacts", move: false },
] as const;

const JOURNAL_FILE = "install-transaction.json";
const JOURNAL_VERSION = 1;

export type InstallTransactionTransition =
  | "journal-created"
  | "node_modules-captured"
  | "artifacts-captured"
  | "action-completed";

/** Test-only failure injection which behaves like an abruptly terminated process. */
export class InstallTransactionInterruptedError extends Error {
  public constructor() {
    super("simulated install transaction interruption");
    this.name = "InstallTransactionInterruptedError";
  }
}

export interface InstallTransactionHooks {
  afterTransition?(transition: InstallTransactionTransition): void;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly backupPath: string;
  readonly existed: boolean;
  readonly move: boolean;
  captured: boolean;
}

interface TransactionJournal {
  readonly version: typeof JOURNAL_VERSION;
  readonly rollbackDirectory: string;
  readonly metadata: readonly JournalFileSnapshot[];
  readonly directories: JournalDirectorySnapshot[];
  status: "active" | "committed";
}

interface JournalFileSnapshot {
  readonly path: (typeof METADATA_PATHS)[number];
  readonly existed: boolean;
  readonly backup: string;
}

interface JournalDirectorySnapshot {
  readonly path: (typeof TRANSACTION_DIRECTORIES)[number]["path"];
  readonly existed: boolean;
  readonly move: boolean;
  captured: boolean;
  recovery: "pending" | "restoring" | "restored";
}

/**
 * Make a package-manager operation all-or-nothing. Before the first mutable
 * rename, a project-local journal records a sibling rollback directory and
 * durable metadata snapshots. A later command can therefore either finish a
 * committed transaction's cleanup or restore an interrupted one.
 */
export async function withInstallTransaction<T>(
  root: string,
  action: () => Promise<T>,
  filesystem: InstallTransactionFs = DEFAULT_INSTALL_TRANSACTION_FS,
  hooks: InstallTransactionHooks = {},
): Promise<T> {
  const projectRoot = resolve(root);
  recoverInterruptedInstall(projectRoot, filesystem);
  const rollbackRoot = filesystem.makeSiblingTemporaryDirectory(
    projectRoot,
    `.${basename(projectRoot)}.tsx-lvgl-install-rollback-`,
  );
  let journal: TransactionJournal | undefined;
  try {
    const metadata = METADATA_PATHS.map((path) => snapshotFile(join(projectRoot, path), filesystem));
    const directories = TRANSACTION_DIRECTORIES.map((definition) => snapshotDirectory(projectRoot, rollbackRoot, definition.path, definition.move, filesystem));
    journal = createJournal(projectRoot, rollbackRoot, metadata, directories);
    writeJournal(projectRoot, journal);
    hooks.afterTransition?.("journal-created");

    captureDirectories(directories, filesystem, (directory) => {
      const path = directory.path === join(projectRoot, "node_modules")
        ? "node_modules"
        : ".tsx-lvgl/artifacts";
      const entry = journal!.directories.find((candidate) => candidate.path === path) as JournalDirectorySnapshot;
      entry.captured = directory.captured;
      writeJournal(projectRoot, journal!);
      hooks.afterTransition?.(directory.path === join(projectRoot, "node_modules") ? "node_modules-captured" : "artifacts-captured");
    });
    const result = await action();
    hooks.afterTransition?.("action-completed");
    journal.status = "committed";
    writeJournal(projectRoot, journal);
    cleanupJournal(projectRoot, rollbackRoot, filesystem);
    return result;
  } catch (error) {
    if (error instanceof InstallTransactionInterruptedError) throw error;
    if (journal !== undefined) recoverInterruptedInstall(projectRoot, filesystem);
    else cleanupOwnedRollbackDirectory(projectRoot, rollbackRoot, filesystem);
    throw error;
  }
}

/** Recover a transaction left by a killed process. Safe to run repeatedly. */
export function recoverInterruptedInstall(
  root: string,
  filesystem: InstallTransactionFs = DEFAULT_INSTALL_TRANSACTION_FS,
): void {
  const projectRoot = resolve(root);
  if (!existsSync(projectRoot)) return;
  const journal = readJournal(projectRoot);
  if (journal === undefined) {
    cleanupStaleRollbackDirectories(projectRoot, undefined, filesystem);
    cleanupStaleJournalFiles(projectRoot);
    return;
  }
  const rollbackRoot = resolveRollbackRoot(projectRoot, journal.rollbackDirectory);
  cleanupStaleRollbackDirectories(projectRoot, journal.rollbackDirectory, filesystem);
  if (journal.status === "committed") {
    cleanupJournal(projectRoot, rollbackRoot, filesystem);
    return;
  }

  for (const directory of journal.directories) restoreDirectory(projectRoot, rollbackRoot, directory, journal, filesystem);
  restoreFiles(readMetadataSnapshots(projectRoot, rollbackRoot, journal), filesystem);
  cleanupJournal(projectRoot, rollbackRoot, filesystem);
}

function createJournal(
  root: string,
  rollbackRoot: string,
  metadata: readonly FileSnapshot[],
  directories: readonly DirectorySnapshot[],
): TransactionJournal {
  const rollbackDirectory = basename(rollbackRoot);
  resolveRollbackRoot(root, rollbackDirectory);
  const snapshots = metadata.map((snapshot, index) => {
    const backup = `metadata/${index}`;
    if (snapshot.existed) {
      mkdirSync(dirname(join(rollbackRoot, backup)), { recursive: true });
      writeFileSync(join(rollbackRoot, backup), snapshot.bytes as Buffer, { mode: 0o600 });
    }
    return { path: METADATA_PATHS[index]!, existed: snapshot.existed, backup };
  });
  return {
    version: JOURNAL_VERSION,
    rollbackDirectory,
    metadata: snapshots,
    directories: directories.map((directory, index) => ({
      path: TRANSACTION_DIRECTORIES[index]!.path,
      existed: directory.existed,
      move: directory.move,
      captured: directory.captured,
      recovery: "pending",
    })),
    status: "active",
  };
}

function readMetadataSnapshots(root: string, rollbackRoot: string, journal: TransactionJournal): readonly FileSnapshot[] {
  return journal.metadata.map((snapshot) => {
    try {
      return {
        path: join(root, snapshot.path),
        existed: snapshot.existed,
        ...(snapshot.existed ? { bytes: readFileSync(join(rollbackRoot, snapshot.backup)) } : {}),
      };
    } catch {
      throw recoveryFailure(`rollback metadata is missing for ${snapshot.path}`);
    }
  });
}

function snapshotDirectory(
  root: string,
  rollbackRoot: string,
  path: string,
  move: boolean,
  filesystem: InstallTransactionFs,
): DirectorySnapshot {
  const destination = join(root, path);
  const existed = filesystem.exists(destination);
  return {
    path: destination,
    backupPath: join(rollbackRoot, path),
    existed,
    move,
    captured: !existed,
  };
}

/** Capture every mutable directory before the package-manager action starts. */
function captureDirectories(
  directories: readonly DirectorySnapshot[],
  filesystem: InstallTransactionFs,
  captured: (directory: DirectorySnapshot) => void,
): void {
  for (const directory of directories) {
    if (!directory.existed) {
      captured(directory);
      continue;
    }
    if (!directory.move) (filesystem.validateArtifactDirectory ?? validateFlatArtifactDirectory)(directory.path);
    filesystem.makeDirectory(dirname(directory.backupPath));
    if (directory.move) filesystem.rename(directory.path, directory.backupPath);
    else filesystem.copy(directory.path, directory.backupPath);
    directory.captured = true;
    captured(directory);
  }
}

function restoreDirectory(
  root: string,
  rollbackRoot: string,
  directory: JournalDirectorySnapshot,
  journal: TransactionJournal,
  filesystem: InstallTransactionFs,
): void {
  if (directory.recovery === "restored") return;
  const destination = join(root, directory.path);
  const backup = join(rollbackRoot, directory.path);
  const backupExists = filesystem.exists(backup);
  const destinationExists = filesystem.exists(destination);
  if (!directory.captured) {
    // A node_modules rename is atomic: seeing only its sibling backup means
    // termination occurred after the rename but before the checkpoint write.
    if (directory.move && !destinationExists && backupExists) {
      directory.recovery = "restoring";
      writeJournal(root, journal);
      filesystem.makeDirectory(dirname(destination));
      filesystem.rename(backup, destination);
    } else if (!destinationExists || (directory.move && backupExists)) {
      throw recoveryFailure(`rollback capture is ambiguous for ${directory.path}`);
    }
    directory.recovery = "restored";
    writeJournal(root, journal);
    return;
  }

  if (directory.recovery === "restoring" && directory.existed && !backupExists && destinationExists) {
    directory.recovery = "restored";
    writeJournal(root, journal);
    return;
  }
  directory.recovery = "restoring";
  writeJournal(root, journal);
  filesystem.remove(destination, { recursive: true, force: true });
  if (directory.existed) {
    if (!filesystem.exists(backup)) {
      throw recoveryFailure(`rollback backup is missing for ${directory.path}`);
    }
    filesystem.makeDirectory(dirname(destination));
    filesystem.rename(backup, destination);
  }
  directory.recovery = "restored";
  writeJournal(root, journal);
}

function snapshotFile(path: string, filesystem: InstallTransactionFs): FileSnapshot {
  return filesystem.exists(path)
    ? { path, existed: true, bytes: filesystem.readFile(path) }
    : { path, existed: false };
}

function restoreFiles(snapshots: readonly FileSnapshot[], filesystem: InstallTransactionFs): void {
  for (const snapshot of snapshots) {
    filesystem.remove(snapshot.path, { force: true });
    if (snapshot.existed) {
      filesystem.makeDirectory(dirname(snapshot.path));
      filesystem.writeFile(snapshot.path, snapshot.bytes as Buffer);
    }
  }
}

function writeJournal(root: string, journal: TransactionJournal): void {
  const state = stateDirectory(root, true)!;
  const target = join(state, JOURNAL_FILE);
  const temporary = join(state, `.${JOURNAL_FILE}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function readJournal(root: string): TransactionJournal | undefined {
  const state = stateDirectory(root, false);
  if (state === undefined) return undefined;
  const path = join(state, JOURNAL_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const details = lstatSync(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("not a regular file");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return validateJournal(root, parsed);
  } catch {
    throw recoveryFailure("install transaction journal is invalid");
  }
}

function validateJournal(root: string, value: unknown): TransactionJournal {
  if (!isRecord(value) || value.version !== JOURNAL_VERSION || typeof value.rollbackDirectory !== "string" || (value.status !== "active" && value.status !== "committed")) {
    throw recoveryFailure("install transaction journal is invalid");
  }
  resolveRollbackRoot(root, value.rollbackDirectory);
  if (!Array.isArray(value.metadata) || value.metadata.length !== METADATA_PATHS.length || !Array.isArray(value.directories) || value.directories.length !== TRANSACTION_DIRECTORIES.length) {
    throw recoveryFailure("install transaction journal is invalid");
  }
  const metadata = value.metadata.map((entry, index) => {
    if (!isRecord(entry) || entry.path !== METADATA_PATHS[index] || typeof entry.existed !== "boolean" || entry.backup !== `metadata/${index}`) {
      throw recoveryFailure("install transaction journal is invalid");
    }
    return { path: METADATA_PATHS[index]!, existed: entry.existed, backup: entry.backup };
  });
  const directories = value.directories.map((entry, index) => {
    const expected = TRANSACTION_DIRECTORIES[index]!;
    if (
      !isRecord(entry)
      || entry.path !== expected.path
      || entry.move !== expected.move
      || typeof entry.existed !== "boolean"
      || typeof entry.captured !== "boolean"
      || (entry.recovery !== "pending" && entry.recovery !== "restoring" && entry.recovery !== "restored")
    ) throw recoveryFailure("install transaction journal is invalid");
    return {
      path: expected.path,
      existed: entry.existed,
      move: expected.move,
      captured: entry.captured,
      recovery: entry.recovery as JournalDirectorySnapshot["recovery"],
    };
  });
  return { version: JOURNAL_VERSION, rollbackDirectory: value.rollbackDirectory, metadata, directories, status: value.status };
}

function stateDirectory(root: string, create: boolean): string | undefined {
  const state = join(resolve(root), ".tsx-lvgl");
  if (!existsSync(state)) {
    if (!create) return undefined;
    mkdirSync(state, { recursive: true });
  }
  const details = lstatSync(state);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "project state directory must not be a symlink");
  }
  return state;
}

function resolveRollbackRoot(root: string, rollbackDirectory: string): string {
  const expectedPrefix = `.${basename(resolve(root))}.tsx-lvgl-install-rollback-`;
  if (
    !rollbackDirectory.startsWith(expectedPrefix)
    || rollbackDirectory.length === expectedPrefix.length
    || basename(rollbackDirectory) !== rollbackDirectory
  ) throw recoveryFailure("install transaction journal has an unsafe rollback directory");
  return join(dirname(resolve(root)), rollbackDirectory);
}

function cleanupJournal(root: string, rollbackRoot: string, filesystem: InstallTransactionFs): void {
  const journal = join(stateDirectory(root, true)!, JOURNAL_FILE);
  filesystem.remove(journal, { force: true });
  cleanupOwnedRollbackDirectory(root, rollbackRoot, filesystem);
  cleanupStaleRollbackDirectories(root, undefined, filesystem);
  cleanupStaleJournalFiles(root);
}

function cleanupOwnedRollbackDirectory(root: string, rollbackRoot: string, filesystem: InstallTransactionFs): void {
  if (dirname(rollbackRoot) !== dirname(resolve(root))) throw recoveryFailure("rollback directory escapes the project sibling");
  const details = existsSync(rollbackRoot) ? lstatSync(rollbackRoot) : undefined;
  if (details !== undefined && details.isDirectory() && !details.isSymbolicLink()) {
    filesystem.remove(rollbackRoot, { recursive: true, force: true });
  }
}

function cleanupStaleRollbackDirectories(root: string, keep: string | undefined, filesystem: InstallTransactionFs): void {
  const prefix = `.${basename(resolve(root))}.tsx-lvgl-install-rollback-`;
  for (const entry of readdirSync(dirname(resolve(root)))) {
    if (entry === keep || !entry.startsWith(prefix) || entry.length === prefix.length) continue;
    cleanupOwnedRollbackDirectory(root, join(dirname(resolve(root)), entry), filesystem);
  }
}

function cleanupStaleJournalFiles(root: string): void {
  const state = stateDirectory(root, false);
  if (state === undefined) return;
  const prefix = `.${JOURNAL_FILE}.`;
  for (const entry of readdirSync(state)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
    const path = join(state, entry);
    const details = lstatSync(path);
    if (details.isFile() && !details.isSymbolicLink()) rmSync(path, { force: true });
  }
}

function validateFlatArtifactDirectory(path: string): void {
  const directory = lstatSync(path);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("artifact transaction source must be a regular directory");
  }
  for (const entry of readdirSync(path)) {
    const details = lstatSync(join(path, entry));
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error("artifact transaction source contains an unsupported entry");
    }
  }
}

function recoveryFailure(message: string): CliError {
  return new CliError(DIAGNOSTIC_CODES.INSTALL_RECOVERY_FAILED, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
