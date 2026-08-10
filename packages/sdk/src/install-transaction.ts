import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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
  syncFile?(path: string): void;
  syncDirectory?(path: string): void;
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
  syncFile: syncFile,
  syncDirectory: syncDirectory,
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
const PENDING_ROLLBACK_FILE = "install-transaction-pending.json";
const ROLLBACK_OWNER_FILE = ".tsx-lvgl-install-owner.json";
const JOURNAL_VERSION = 1;

export type InstallTransactionTransition =
  | "journal-created"
  | "node_modules-captured"
  | "artifacts-captured"
  | "action-completed"
  | "cleanup-recorded";

/** Test-only failure injection which behaves like an abruptly terminated process. */
export class InstallTransactionInterruptedError extends Error {
  public constructor() {
    super("simulated install transaction interruption");
    this.name = "InstallTransactionInterruptedError";
  }
}

export interface InstallTransactionHooks {
  afterTransition?(transition: InstallTransactionTransition): void;
  beforeJournalPersist?(stateDirectory: string): void;
  beforeRollbackPersist?(rollbackDirectory: string): void;
  beforeJournalTemporaryOpen?(temporaryPath: string): void;
  beforeOwnedJournalTemporaryCleanup?(temporaryPath: string): void;
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
  readonly rollbackToken: string;
  readonly metadata: readonly JournalFileSnapshot[];
  readonly directories: JournalDirectorySnapshot[];
  status: "active" | "committed" | "cleanup";
}

interface PendingRollback {
  readonly version: typeof JOURNAL_VERSION;
  readonly rollbackDirectory: string;
  readonly rollbackToken: string;
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
    journal = createJournal(projectRoot, rollbackRoot, metadata, directories, filesystem, hooks);
    writeJournal(projectRoot, journal, filesystem, hooks);
    clearPendingRollback(projectRoot, journal, filesystem);
    hooks.afterTransition?.("journal-created");

    captureDirectories(projectRoot, rollbackRoot, directories, filesystem, (directory) => {
      const path = directory.path === join(projectRoot, "node_modules")
        ? "node_modules"
        : ".tsx-lvgl/artifacts";
      const entry = journal!.directories.find((candidate) => candidate.path === path) as JournalDirectorySnapshot;
      entry.captured = directory.captured;
      writeJournal(projectRoot, journal!, filesystem, hooks);
      hooks.afterTransition?.(directory.path === join(projectRoot, "node_modules") ? "node_modules-captured" : "artifacts-captured");
    });
    const result = await action();
    hooks.afterTransition?.("action-completed");
    journal.status = "committed";
    writeJournal(projectRoot, journal, filesystem, hooks);
    cleanupJournal(projectRoot, rollbackRoot, journal, filesystem, hooks);
    return result;
  } catch (error) {
    if (error instanceof InstallTransactionInterruptedError) throw error;
    if (journal !== undefined) recoverInterruptedInstall(projectRoot, filesystem);
    throw error;
  }
}

/** Recover a transaction left by a killed process. Safe to run repeatedly. */
export function recoverInterruptedInstall(
  root: string,
  filesystem: InstallTransactionFs = DEFAULT_INSTALL_TRANSACTION_FS,
  hooks: InstallTransactionHooks = {},
): void {
  const projectRoot = resolve(root);
  if (!existsSync(projectRoot)) return;
  const journal = readJournal(projectRoot);
  if (journal === undefined) {
    const pending = readPendingRollback(projectRoot);
    if (pending !== undefined) recoverPendingRollback(projectRoot, pending, filesystem);
    return;
  }
  const rollbackRoot = resolveRollbackRoot(projectRoot, journal.rollbackDirectory);
  if (journal.status === "committed" || journal.status === "cleanup") {
    cleanupJournal(projectRoot, rollbackRoot, journal, filesystem, hooks);
    return;
  }

  for (const directory of journal.directories) restoreDirectory(projectRoot, rollbackRoot, directory, journal, filesystem);
  restoreFiles(readMetadataSnapshots(projectRoot, rollbackRoot, journal), filesystem);
  cleanupJournal(projectRoot, rollbackRoot, journal, filesystem, hooks);
}

function createJournal(
  root: string,
  rollbackRoot: string,
  metadata: readonly FileSnapshot[],
  directories: readonly DirectorySnapshot[],
  filesystem: InstallTransactionFs,
  hooks: InstallTransactionHooks,
): TransactionJournal {
  const rollbackDirectory = basename(rollbackRoot);
  resolveRollbackRoot(root, rollbackDirectory);
  const rollbackToken = randomBytes(32).toString("hex");
  writePendingRollback(root, { version: JOURNAL_VERSION, rollbackDirectory, rollbackToken }, filesystem);
  hooks.beforeRollbackPersist?.(rollbackRoot);
  assertRollbackDirectory(root, rollbackRoot);
  writeRollbackOwnership(root, rollbackRoot, rollbackToken, filesystem);
  const metadataRoot = join(rollbackRoot, "metadata");
  const snapshots = metadata.map((snapshot, index) => {
    const backup = `metadata/${index}`;
    if (snapshot.existed) {
      assertRollbackDirectory(root, rollbackRoot);
      mkdirSync(metadataRoot, { recursive: true });
      assertRollbackChildDirectory(root, rollbackRoot, metadataRoot);
      const backupPath = join(rollbackRoot, backup);
      writeExclusiveFile(backupPath, snapshot.bytes as Buffer);
      persistFile(backupPath, filesystem);
    }
    return { path: METADATA_PATHS[index]!, existed: snapshot.existed, backup };
  });
  persistDirectory(metadataRoot, filesystem);
  persistDirectory(rollbackRoot, filesystem);
  return {
    version: JOURNAL_VERSION,
    rollbackDirectory,
    rollbackToken,
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
  assertRollbackDirectory(root, rollbackRoot);
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
  projectRoot: string,
  rollbackRoot: string,
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
    assertRollbackDirectory(projectRoot, rollbackRoot);
    filesystem.makeDirectory(dirname(directory.backupPath));
    assertRollbackDirectory(projectRoot, rollbackRoot);
    if (directory.move) {
      filesystem.rename(directory.path, directory.backupPath);
      persistDirectory(dirname(directory.path), filesystem);
      persistDirectory(dirname(directory.backupPath), filesystem);
    } else {
      filesystem.copy(directory.path, directory.backupPath);
      persistDirectoryTree(directory.backupPath, filesystem);
    }
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
      writeJournal(root, journal, filesystem);
      filesystem.makeDirectory(dirname(destination));
      filesystem.rename(backup, destination);
      persistDirectory(dirname(backup), filesystem);
      persistDirectory(dirname(destination), filesystem);
    } else if (!destinationExists || (directory.move && backupExists)) {
      throw recoveryFailure(`rollback capture is ambiguous for ${directory.path}`);
    }
    directory.recovery = "restored";
    writeJournal(root, journal, filesystem);
    return;
  }

  if (directory.recovery === "restoring" && directory.existed && !backupExists && destinationExists) {
    directory.recovery = "restored";
    writeJournal(root, journal, filesystem);
    return;
  }
  directory.recovery = "restoring";
  writeJournal(root, journal, filesystem);
  filesystem.remove(destination, { recursive: true, force: true });
  if (directory.existed) {
    if (!filesystem.exists(backup)) {
      throw recoveryFailure(`rollback backup is missing for ${directory.path}`);
    }
    filesystem.makeDirectory(dirname(destination));
    filesystem.rename(backup, destination);
    persistDirectory(dirname(backup), filesystem);
    persistDirectory(dirname(destination), filesystem);
  }
  directory.recovery = "restored";
  writeJournal(root, journal, filesystem);
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
      persistFile(snapshot.path, filesystem);
    }
    persistDirectory(dirname(snapshot.path), filesystem);
  }
}

function writeJournal(
  root: string,
  journal: TransactionJournal,
  filesystem: InstallTransactionFs,
  hooks: InstallTransactionHooks = {},
): void {
  const state = stateDirectoryWithDurability(root, filesystem);
  const target = join(state, JOURNAL_FILE);
  const temporary = join(state, `.${JOURNAL_FILE}.${journal.rollbackToken}.${randomBytes(16).toString("hex")}.tmp`);
  hooks.beforeJournalPersist?.(state);
  assertProjectStateDirectory(root, state);
  hooks.beforeJournalTemporaryOpen?.(temporary);
  writeExclusiveFile(temporary, Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"));
  persistFile(temporary, filesystem);
  assertProjectStateDirectory(root, state);
  renameSync(temporary, target);
  persistDirectory(state, filesystem);
}

function writeExclusiveFile(path: string, bytes: Buffer): void {
  const descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    }
  } finally {
    closeSync(descriptor);
  }
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
  if (
    !isRecord(value)
    || value.version !== JOURNAL_VERSION
    || typeof value.rollbackDirectory !== "string"
    || typeof value.rollbackToken !== "string"
    || !/^[a-f0-9]{64}$/.test(value.rollbackToken)
    || (value.status !== "active" && value.status !== "committed" && value.status !== "cleanup")
  ) {
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
  return {
    version: JOURNAL_VERSION,
    rollbackDirectory: value.rollbackDirectory,
    rollbackToken: value.rollbackToken,
    metadata,
    directories,
    status: value.status,
  };
}

function stateDirectory(root: string, create: boolean): string | undefined {
  const state = join(resolve(root), ".tsx-lvgl");
  if (!existsSync(state)) {
    if (!create) return undefined;
    mkdirSync(state, { recursive: true });
  }
  assertProjectStateDirectory(root, state);
  return state;
}

function stateDirectoryWithDurability(root: string, filesystem: InstallTransactionFs): string {
  const statePath = join(resolve(root), ".tsx-lvgl");
  const stateWasAbsent = !existsSync(statePath);
  const state = stateDirectory(root, true)!;
  if (stateWasAbsent) {
    persistDirectory(resolve(root), filesystem);
    persistDirectory(state, filesystem);
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

function writeRollbackOwnership(
  projectRoot: string,
  rollbackRoot: string,
  rollbackToken: string,
  filesystem: InstallTransactionFs,
): void {
  assertRollbackDirectory(projectRoot, rollbackRoot);
  const marker = join(rollbackRoot, ROLLBACK_OWNER_FILE);
  writeExclusiveFile(marker, Buffer.from(`${JSON.stringify({ version: 1, rollbackToken })}\n`, "utf8"));
  persistFile(marker, filesystem);
  persistDirectory(rollbackRoot, filesystem);
  persistDirectory(dirname(rollbackRoot), filesystem);
}

function writePendingRollback(root: string, pending: PendingRollback, filesystem: InstallTransactionFs): void {
  const state = stateDirectoryWithDurability(root, filesystem);
  writeStateRecord(root, state, PENDING_ROLLBACK_FILE, pending, filesystem);
}

function readPendingRollback(root: string): PendingRollback | undefined {
  const state = stateDirectory(root, false);
  if (state === undefined) return undefined;
  const path = join(state, PENDING_ROLLBACK_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const details = lstatSync(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("not a regular file");
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      !isRecord(value)
      || value.version !== JOURNAL_VERSION
      || typeof value.rollbackDirectory !== "string"
      || typeof value.rollbackToken !== "string"
      || !/^[a-f0-9]{64}$/.test(value.rollbackToken)
    ) throw new Error("invalid pending rollback");
    resolveRollbackRoot(root, value.rollbackDirectory);
    return { version: JOURNAL_VERSION, rollbackDirectory: value.rollbackDirectory, rollbackToken: value.rollbackToken };
  } catch {
    throw recoveryFailure("pending install rollback is invalid");
  }
}

function recoverPendingRollback(root: string, pending: PendingRollback, filesystem: InstallTransactionFs): void {
  const rollbackRoot = resolveRollbackRoot(root, pending.rollbackDirectory);
  if (existsSync(rollbackRoot) && isOwnedRollbackDirectory(root, rollbackRoot, pending.rollbackToken)) {
    cleanupOwnedRollbackDirectory(root, rollbackRoot, pending.rollbackToken, filesystem);
  }
  clearPendingRollback(root, pending, filesystem);
}

function clearPendingRollback(root: string, expected: PendingRollback | TransactionJournal, filesystem: InstallTransactionFs): void {
  const pending = readPendingRollback(root);
  if (pending === undefined) return;
  if (pending.rollbackDirectory !== expected.rollbackDirectory || pending.rollbackToken !== expected.rollbackToken) {
    throw recoveryFailure("pending install rollback does not match the transaction");
  }
  const state = stateDirectory(root, false)!;
  assertProjectStateDirectory(root, state);
  filesystem.remove(join(state, PENDING_ROLLBACK_FILE), { force: true });
  persistDirectory(state, filesystem);
}

function writeStateRecord(
  root: string,
  state: string,
  file: string,
  value: PendingRollback,
  filesystem: InstallTransactionFs,
): void {
  const target = join(state, file);
  const temporary = join(state, `.${file}.${randomBytes(16).toString("hex")}.tmp`);
  assertProjectStateDirectory(root, state);
  writeExclusiveFile(temporary, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
  persistFile(temporary, filesystem);
  assertProjectStateDirectory(root, state);
  renameSync(temporary, target);
  persistDirectory(state, filesystem);
}

function isOwnedRollbackDirectory(projectRoot: string, rollbackRoot: string, expectedToken: string): boolean {
  const marker = join(rollbackRoot, ROLLBACK_OWNER_FILE);
  try {
    assertRollbackDirectory(projectRoot, rollbackRoot);
    const details = lstatSync(marker);
    if (!details.isFile() || details.isSymbolicLink()) return false;
    const value = JSON.parse(readFileSync(marker, "utf8")) as unknown;
    return isRecord(value) && value.version === 1 && value.rollbackToken === expectedToken;
  } catch {
    return false;
  }
}

function assertRollbackDirectory(projectRoot: string, rollbackRoot: string): void {
  const expectedParent = canonicalDirectory(dirname(resolve(projectRoot)), "rollback parent is unavailable");
  const details = lstatSync(rollbackRoot);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw recoveryFailure("rollback directory must not be a symlink");
  }
  const canonicalRollback = canonicalDirectory(rollbackRoot, "rollback directory is unavailable");
  if (dirname(canonicalRollback) !== expectedParent || basename(canonicalRollback) !== basename(rollbackRoot)) {
    throw recoveryFailure("rollback directory escapes the project sibling");
  }
}

function assertRollbackChildDirectory(projectRoot: string, rollbackRoot: string, child: string): void {
  assertRollbackDirectory(projectRoot, rollbackRoot);
  const details = lstatSync(child);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw recoveryFailure("rollback metadata directory must not be a symlink");
  }
  const canonicalRollback = canonicalDirectory(rollbackRoot, "rollback directory is unavailable");
  const canonicalChild = canonicalDirectory(child, "rollback metadata directory is unavailable");
  if (!isContained(canonicalRollback, canonicalChild)) {
    throw recoveryFailure("rollback metadata directory escapes its transaction");
  }
}

function assertProjectStateDirectory(root: string, state: string): void {
  const rootCanonical = canonicalDirectory(root, "project root is unavailable");
  const details = lstatSync(state);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "project state directory must not be a symlink");
  }
  const stateCanonical = canonicalDirectory(state, "project state directory is unavailable");
  if (!isContained(rootCanonical, stateCanonical)) {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, "project state directory escapes the project");
  }
}

function canonicalDirectory(path: string, message: string): string {
  try {
    if (!lstatSync(path).isDirectory()) throw new Error("not a directory");
    return realpathSync(path);
  } catch {
    throw new CliError(DIAGNOSTIC_CODES.SOURCE_PATH_LEAK, message);
  }
}

function isContained(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function persistFile(path: string, filesystem: InstallTransactionFs): void {
  filesystem.syncFile?.(path);
}

function persistDirectory(path: string, filesystem: InstallTransactionFs): void {
  if (existsSync(path)) filesystem.syncDirectory?.(path);
}

function persistDirectoryTree(path: string, filesystem: InstallTransactionFs): void {
  const details = lstatSync(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw recoveryFailure("rollback artifact snapshot is not a regular directory");
  }
  for (const entry of readdirSync(path)) {
    const entryPath = join(path, entry);
    const entryDetails = lstatSync(entryPath);
    if (!entryDetails.isFile() || entryDetails.isSymbolicLink()) {
      throw recoveryFailure("rollback artifact snapshot contains an unsupported entry");
    }
    persistFile(entryPath, filesystem);
  }
  persistDirectory(path, filesystem);
  persistDirectory(dirname(path), filesystem);
}

function syncFile(path: string): void {
  syncPath(path);
}

function syncDirectory(path: string): void {
  syncPath(path);
}

function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupJournal(
  root: string,
  rollbackRoot: string,
  transaction: TransactionJournal,
  filesystem: InstallTransactionFs,
  hooks: InstallTransactionHooks = {},
): void {
  if (transaction.status !== "cleanup") {
    transaction.status = "cleanup";
    writeJournal(root, transaction, filesystem, hooks);
    hooks.afterTransition?.("cleanup-recorded");
  }
  cleanupOwnedRollbackDirectory(root, rollbackRoot, transaction.rollbackToken, filesystem);
  cleanupOwnedJournalTemporaryFiles(root, transaction, hooks);
  const journal = join(stateDirectory(root, true)!, JOURNAL_FILE);
  assertProjectStateDirectory(root, dirname(journal));
  filesystem.remove(journal, { force: true });
  persistDirectory(dirname(journal), filesystem);
  clearPendingRollback(root, transaction, filesystem);
}

function cleanupOwnedRollbackDirectory(
  root: string,
  rollbackRoot: string,
  rollbackToken: string,
  filesystem: InstallTransactionFs,
): void {
  if (dirname(rollbackRoot) !== dirname(resolve(root))) throw recoveryFailure("rollback directory escapes the project sibling");
  const details = existsSync(rollbackRoot) ? lstatSync(rollbackRoot) : undefined;
  if (details !== undefined) {
    if (!details.isDirectory() || details.isSymbolicLink() || !isOwnedRollbackDirectory(root, rollbackRoot, rollbackToken)) {
      throw recoveryFailure("rollback directory ownership cannot be verified");
    }
    assertRollbackDirectory(root, rollbackRoot);
    filesystem.remove(rollbackRoot, { recursive: true, force: true });
    persistDirectory(dirname(rollbackRoot), filesystem);
  }
}

function cleanupOwnedJournalTemporaryFiles(
  root: string,
  transaction: TransactionJournal,
  hooks: InstallTransactionHooks,
): void {
  const state = stateDirectory(root, false);
  if (state === undefined) return;
  const prefix = `.${JOURNAL_FILE}.${transaction.rollbackToken}.`;
  for (const entry of readdirSync(state)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
    const path = join(state, entry);
    const details = lstatSync(path);
    if (!details.isFile() || details.isSymbolicLink()) continue;
    hooks.beforeOwnedJournalTemporaryCleanup?.(path);
    assertProjectStateDirectory(root, state);
    const current = lstatSync(path);
    if (current.isFile() && !current.isSymbolicLink()) rmSync(path, { force: true });
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
