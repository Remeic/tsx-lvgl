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
  let rollbackRoot: string | undefined;
  let metadata: readonly FileSnapshot[] = [];
  let directories: readonly DirectorySnapshot[] = [];
  try {
    const activeRollbackRoot = filesystem.makeSiblingTemporaryDirectory(root, `.${basename(root)}.tsx-lvgl-install-rollback-`);
    rollbackRoot = activeRollbackRoot;
    metadata = METADATA_PATHS.map((path) => snapshotFile(join(root, path), filesystem));
    directories = TRANSACTION_DIRECTORIES.map((definition) => snapshotDirectory(root, activeRollbackRoot, definition.path, definition.move, filesystem));
    for (const directory of directories) {
      if (directory.existed) {
        filesystem.makeDirectory(dirname(directory.backupPath));
        if (directory.move) filesystem.rename(directory.path, directory.backupPath);
        else filesystem.copy(directory.path, directory.backupPath);
      }
    }
    const result = await action();
    return result;
  } catch (error) {
    for (const directory of directories) {
      filesystem.remove(directory.path, { recursive: true, force: true });
      if (directory.existed && filesystem.exists(directory.backupPath)) {
        filesystem.makeDirectory(dirname(directory.path));
        filesystem.rename(directory.backupPath, directory.path);
      }
    }
    restoreFiles(metadata, filesystem);
    throw error;
  } finally {
    if (rollbackRoot !== undefined) filesystem.remove(rollbackRoot, { recursive: true, force: true });
  }
}

interface DirectorySnapshot {
  readonly path: string;
  readonly backupPath: string;
  readonly existed: boolean;
  readonly move: boolean;
}

function snapshotDirectory(
  root: string,
  rollbackRoot: string,
  path: string,
  move: boolean,
  filesystem: InstallTransactionFs,
): DirectorySnapshot {
  const destination = join(root, path);
  return {
    path: destination,
    backupPath: join(rollbackRoot, path),
    existed: filesystem.exists(destination),
    move,
  };
}

function snapshotFile(path: string, filesystem: InstallTransactionFs): FileSnapshot {
  return filesystem.exists(path)
    ? { path, existed: true, bytes: filesystem.readFile(path) }
    : { path, existed: false };
}

function restoreFiles(snapshots: readonly FileSnapshot[], filesystem: InstallTransactionFs): void {
  for (const snapshot of snapshots) {
    filesystem.remove(snapshot.path, { force: true });
    if (snapshot.existed && snapshot.bytes !== undefined) {
      filesystem.makeDirectory(dirname(snapshot.path));
      filesystem.writeFile(snapshot.path, snapshot.bytes);
    }
  }
}
