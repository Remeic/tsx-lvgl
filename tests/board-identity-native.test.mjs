import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identityHeader = resolve(repoRoot, "examples/esp-idf/components/tsx_board_adapter/include");
const identitySource = resolve(repoRoot, "examples/esp-idf/components/tsx_board_adapter/tsx_board_identity.c");
const fixtureSource = resolve(repoRoot, "tests/fixtures/board_identity_fixture.c");

test("board identity classifier compiles as strict C11 and covers every evidence transition", async () => {
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "tsx-board-identity-"));
  const executable = resolve(temporaryDirectory, "board-identity-fixture");
  try {
    const compile = spawnSync("cc", [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      "-I",
      identityHeader,
      identitySource,
      fixtureSource,
      "-o",
      executable,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);

    const run = spawnSync(executable, [], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("identity classifier source has no ESP-IDF or I/O dependency", async () => {
  const source = await readFile(identitySource, "utf8");
  assert.doesNotMatch(source, /esp_|i2c_|bsp_|freertos/i);
});
