import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface FileSnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes?: Buffer;
}

export interface InstallTransactionFs {
  exists(path: string): boolean;
  makeTemporaryDirectory(prefix: string): string;
  readFile(path: string): Buffer;
  rename(from: string, to: string): void;
  remove(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
  makeDirectory(path: string): void;
  writeFile(path: string, bytes: Buffer): void;
}

export const DEFAULT_INSTALL_TRANSACTION_FS: InstallTransactionFs = {
  exists: existsSync,
  makeTemporaryDirectory: mkdtempSync,
  readFile: readFileSync,
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
  ".tsx-lvgl/framework.lock.json",
] as const;

/**
 * Make a package-manager operation all-or-nothing. node_modules is moved as
 * one opaque directory so every manager-specific entry, including unrelated
 * dependencies and symlinks, is restored after a failed install.
 */
export async function withInstallTransaction<T>(
  root: string,
  action: () => Promise<T>,
  filesystem: InstallTransactionFs = DEFAULT_INSTALL_TRANSACTION_FS,
): Promise<T> {
  const rollbackRoot = filesystem.makeTemporaryDirectory(join(process.env.TMPDIR ?? "/tmp", "tsx-lvgl-install-rollback-"));
  const metadata = METADATA_PATHS.map((path) => snapshotFile(join(root, path), filesystem));
  const nodeModules = join(root, "node_modules");
  const nodeModulesBackup = join(rollbackRoot, "node_modules");
  const hadNodeModules = filesystem.exists(nodeModules);

  if (hadNodeModules) filesystem.rename(nodeModules, nodeModulesBackup);
  try {
    const result = await action();
    filesystem.remove(rollbackRoot, { recursive: true, force: true });
    return result;
  } catch (error) {
    filesystem.remove(nodeModules, { recursive: true, force: true });
    if (hadNodeModules) {
      filesystem.makeDirectory(dirname(nodeModules));
      filesystem.rename(nodeModulesBackup, nodeModules);
    }
    restoreFiles(metadata, filesystem);
    filesystem.remove(rollbackRoot, { recursive: true, force: true });
    throw error;
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
    if (snapshot.existed && snapshot.bytes !== undefined) {
      filesystem.makeDirectory(dirname(snapshot.path));
      filesystem.writeFile(snapshot.path, snapshot.bytes);
    }
  }
}
