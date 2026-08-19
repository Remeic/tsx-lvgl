import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "waveshare-touch-amoled-1.8-v1";

test("board-reload forwards the selected target to the execute-mode build", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "tsx-lvgl-board-reload-wrapper-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const fakeBin = join(sandbox, "bin");
  const npmCapture = join(sandbox, "npm.args");
  const nodeCapture = join(sandbox, "node.args");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, "npm"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > \"$CAPTURE_NPM\"\n", { mode: 0o755 });
  await writeFile(join(fakeBin, "node"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > \"$CAPTURE_NODE\"\n", { mode: 0o755 });
  await chmod(join(fakeBin, "npm"), 0o755);
  await chmod(join(fakeBin, "node"), 0o755);

  const environment = {
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    CAPTURE_NPM: npmCapture,
    CAPTURE_NODE: nodeCapture,
  };
  delete environment.TSX_LVGL_SKIP_BUILD;

  await execFile(join(repositoryRoot, "tools/board-reload"), ["--target", TARGET, "--execute"], {
    cwd: repositoryRoot,
    env: environment,
  });

  assert.equal(await readFile(npmCapture, "utf8"), `run board:build -- --target ${TARGET}\n`);
  assert.equal(
    await readFile(nodeCapture, "utf8"),
    `${join(repositoryRoot, "scripts/board-reload.mjs")} --target ${TARGET} --execute\n`,
  );
});
