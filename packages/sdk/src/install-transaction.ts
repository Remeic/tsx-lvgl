import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

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

/**
 * Make a package-manager operation all-or-nothing. Mutable dependency and
 * dependency directories are moved and old artifacts copied as opaque trees to
 * a sibling on the project filesystem. This preserves the artifact currently
 * being installed while ensuring every pre-existing byte returns on failure.
 */
export async function withInstallTransaction<T>(
  root: string,
  action: () => Promise<T>,
  filesystem: InstallTransactionFs = DEFAULT_INSTALL_TRANSACTION_FS,
): Promise<T> {
  const rollbackRoot = filesystem.makeSiblingTemporaryDirectory(root, `.${basename(root)}.tsx-lvgl-install-rollback-`);
  let metadata: readonly FileSnapshot[] = [];
  let directories: readonly DirectorySnapshot[] = [];
  try {
    metadata = METADATA_PATHS.map((path) => snapshotFile(join(root, path), filesystem));
    directories = TRANSACTION_DIRECTORIES.map((definition) => snapshotDirectory(root, rollbackRoot, definition.path, definition.move, filesystem));
    captureDirectories(directories, filesystem);
    const result = await action();
    cleanupRollbackRoot(rollbackRoot, filesystem);
    return result;
  } catch (error) {
    for (const directory of directories) {
      // A failed copy leaves the original directory in place. Only a completed
      // capture authorizes rollback to remove a project directory.
      if (!directory.captured) continue;
      filesystem.remove(directory.path, { recursive: true, force: true });
      if (directory.existed && filesystem.exists(directory.backupPath)) {
        filesystem.makeDirectory(dirname(directory.path));
        filesystem.rename(directory.backupPath, directory.path);
      }
    }
    restoreFiles(metadata, filesystem);
    cleanupRollbackRoot(rollbackRoot, filesystem);
    throw error;
  }
}

function cleanupRollbackRoot(root: string, filesystem: InstallTransactionFs): void {
  filesystem.remove(root, { recursive: true, force: true });
}

interface DirectorySnapshot {
  readonly path: string;
  readonly backupPath: string;
  readonly existed: boolean;
  readonly move: boolean;
  captured: boolean;
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
    // An absent directory is a successful empty snapshot: rollback may remove
    // only state created after this point. Existing directories require their
    // backup operation to finish before they become rollback-eligible.
    captured: !existed,
  };
}

/** Capture every mutable directory before the package-manager action starts. */
function captureDirectories(directories: readonly DirectorySnapshot[], filesystem: InstallTransactionFs): void {
  for (const directory of directories) {
    if (!directory.existed) continue;
    filesystem.makeDirectory(dirname(directory.backupPath));
    if (directory.move) filesystem.rename(directory.path, directory.backupPath);
    else filesystem.copy(directory.path, directory.backupPath);
    directory.captured = true;
  }
}

function snapshotFile(path: string, filesystem: InstallTransactionFs): FileSnapshot {
  return filesystem.exists(path)
    ? { path, existed: true, bytes: filesystem.readFile(path) }
    : { path, existed: false };
}

function restoreFiles(snapshots: readonly FileSnapshot[], filesystem: InstallTransactionFs): void {
  for (const snapshot of snapshots) {
    filesystem.remove(snapshot.path, { force: true });
    // snapshotFile always captures bytes for an existing path; testing an
    // undefined value here only creates an unreachable rollback branch.
    if (snapshot.existed) {
      filesystem.makeDirectory(dirname(snapshot.path));
      filesystem.writeFile(snapshot.path, snapshot.bytes as Buffer);
    }
  }
}
