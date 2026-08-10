import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  prepareTestOutput,
  resolveTestOutputDirectory,
} from "../scripts/prepare-test-output.mjs";
import {
  collectValidationContext,
  createValidationContext,
  VALIDATION_GIT_SHA_ENV,
  VALIDATION_GIT_STATE_ENV,
} from "../scripts/validation-context.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("test output preparation removes stale tests without touching other outputs", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "tsx-lvgl-test-output-"));
  t.after(async () => {
    await rm(repositoryRoot, { recursive: true, force: true });
  });

  const staleTest = join(repositoryRoot, "test-dist", "tests", "retired.test.js");
  const packageOutput = join(repositoryRoot, "packages", "core", "dist", "index.js");
  const unrelatedFile = join(repositoryRoot, "notes", "keep.txt");
  await Promise.all([
    mkdir(join(repositoryRoot, "test-dist", "tests"), { recursive: true }),
    mkdir(join(repositoryRoot, "packages", "core", "dist"), { recursive: true }),
    mkdir(join(repositoryRoot, "notes"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(staleTest, "import '@tsx-lvgl/retired';\n"),
    writeFile(packageOutput, "export const keep = true;\n"),
    writeFile(unrelatedFile, "keep\n"),
  ]);

  const removedDirectory = await prepareTestOutput({ repositoryRoot });

  assert.equal(removedDirectory, join(repositoryRoot, "test-dist"));
  await assert.rejects(stat(staleTest), { code: "ENOENT" });
  assert.equal(await readFile(packageOutput, "utf8"), "export const keep = true;\n");
  assert.equal(await readFile(unrelatedFile, "utf8"), "keep\n");
});

test("test output preparation rejects any cleanup target other than test-dist", () => {
  const repositoryRoot = join(tmpdir(), "tsx-lvgl-repository");

  assert.throws(
    () => resolveTestOutputDirectory(repositoryRoot, "packages/core/dist"),
    /must be test-dist/,
  );
  assert.throws(
    () => resolveTestOutputDirectory("relative/repository"),
    /repository root must be absolute/,
  );
});

test("validation context has stable machine-readable fields", () => {
  const context = createValidationContext({
    gitSha: "0123456789abcdef0123456789abcdef01234567\n",
    gitState: "dirty",
    gitSource: "git",
    nodeVersion: "v24.19.0",
    npmVersion: "11.17.0\n",
  });

  assert.deepEqual(context, {
    gitSha: "0123456789abcdef0123456789abcdef01234567",
    gitState: "dirty",
    gitSource: "git",
    nodeVersion: "v24.19.0",
    npmVersion: "11.17.0",
  });
  assert.equal(
    createValidationContext({
      gitSha: "fedcba9876543210fedcba9876543210fedcba98",
      gitState: "clean",
      gitSource: "environment",
      nodeVersion: "v24.19.0",
      npmVersion: "11.17.0",
    }).gitState,
    "clean",
  );
});

test("validation context uses the host snapshot when Git metadata is unavailable", async () => {
  const gitSha = "89abcdef0123456789abcdef0123456789abcdef";
  const run = async (command) => {
    if (command === "npm") {
      return { stdout: "11.17.0\n" };
    }
    const error = new Error("Git command failed");
    error.stderr = "fatal: not a git repository: /missing/worktree/gitdir\n";
    throw error;
  };

  const context = await collectValidationContext({
    cwd: "/workspace",
    run,
    environment: {
      [VALIDATION_GIT_SHA_ENV]: gitSha,
      [VALIDATION_GIT_STATE_ENV]: "dirty",
    },
  });

  assert.deepEqual(context, {
    gitSha,
    gitState: "dirty",
    gitSource: "environment",
    nodeVersion: process.version,
    npmVersion: "11.17.0",
  });
});

test("validation context prefers live Git over a host snapshot", async () => {
  const liveSha = "fedcba9876543210fedcba9876543210fedcba98";
  const run = async (command, arguments_) => {
    if (command === "npm") {
      return { stdout: "11.17.0\n" };
    }
    if (arguments_[0] === "rev-parse") {
      return { stdout: `${liveSha}\n` };
    }
    return { stdout: "" };
  };

  const context = await collectValidationContext({
    cwd: "/repository",
    run,
    environment: {
      [VALIDATION_GIT_SHA_ENV]: "0123456789abcdef0123456789abcdef01234567",
      [VALIDATION_GIT_STATE_ENV]: "dirty",
    },
  });

  assert.equal(context.gitSha, liveSha);
  assert.equal(context.gitState, "clean");
  assert.equal(context.gitSource, "git");
});

test("validation context does not mask non-metadata Git failures", async () => {
  const gitError = new Error("Git permission failure");
  gitError.stderr = "fatal: cannot open the Git index\n";
  const run = async (command) => {
    if (command === "npm") {
      return { stdout: "11.17.0\n" };
    }
    throw gitError;
  };

  await assert.rejects(
    collectValidationContext({
      cwd: "/repository",
      run,
      environment: {
        [VALIDATION_GIT_SHA_ENV]: "0123456789abcdef0123456789abcdef01234567",
        [VALIDATION_GIT_STATE_ENV]: "clean",
      },
    }),
    (error) => error === gitError,
  );
});

test("container wrapper stops when host Git status cannot be read", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "tsx-lvgl-tools-dev-"));
  const fakeBin = join(fixtureRoot, "bin");
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await mkdir(fakeBin, { recursive: true });
  await Promise.all([
    writeFile(
      join(fakeBin, "git"),
      `#!/usr/bin/env bash
case "$*" in
  *"rev-parse --verify HEAD"*) printf '%s\\n' 0123456789abcdef0123456789abcdef01234567 ;;
  *"status --porcelain"*) exit 23 ;;
  *) exit 97 ;;
esac
`,
      { mode: 0o755 },
    ),
    writeFile(join(fakeBin, "docker"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    }),
  ]);

  await assert.rejects(
    execFile(join(repositoryRoot, "tools", "dev"), ["test"], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    }),
    (error) => error.code === 23,
  );
});

test("SDK packing uses a validated hermetic Git snapshot only when metadata is unavailable", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-pack-hermetic-"));
  t.after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });
  const fakeBin = join(sandbox, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeGit = join(fakeBin, "git");
  await writeFile(fakeGit, "#!/bin/sh\necho 'fatal: not a git repository' >&2\nexit 128\n");
  await chmod(fakeGit, 0o755);

  const sourceSha = "0123456789abcdef0123456789abcdef01234567";
  const outputRoot = join(sandbox, "artifact");
  const packed = await execFile(process.execPath, [
    join(repositoryRoot, "scripts", "pack-sdk.mjs"),
    "--out",
    outputRoot,
    "--json",
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      TSX_LVGL_VALIDATION_GIT_SHA: sourceSha,
      TSX_LVGL_VALIDATION_GIT_STATE: "clean",
    },
  });
  const metadata = JSON.parse(packed.stdout);
  assert.equal(metadata.sourceSha, sourceSha);
  assert.equal(metadata.sourceDirty, false);

  await assert.rejects(
    execFile(process.execPath, [join(repositoryRoot, "scripts", "pack-sdk.mjs"), "--json"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        TSX_LVGL_VALIDATION_GIT_SHA: "malformed",
        TSX_LVGL_VALIDATION_GIT_STATE: "missing",
      },
    }),
    /TSX_LVGL_VALIDATION_GIT_SHA must be a full hexadecimal object ID/,
  );
});
