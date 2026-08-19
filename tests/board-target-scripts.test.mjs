import assert from "node:assert/strict";
import test from "node:test";

import { parseCli as parseBoardBuildCli } from "../scripts/board-build.mjs";
import { parseCli as parseBoardInstallCli } from "../scripts/board-install.mjs";
import { parseCli as parseBoardReloadCli } from "../scripts/board-reload.mjs";
import { parseCli as parseBundleCli } from "../scripts/bundle-app.mjs";
import { parseCli as parseEmbedCli } from "../scripts/embed-runtime-app.mjs";

const TARGET = "waveshare-touch-amoled-1.8-v1";
const BOARD_ID = "waveshare.esp32s3.touch-amoled-1.8.v1";

test("firmware commands require the explicit repository target", () => {
  for (const parse of [parseBoardBuildCli, parseBoardInstallCli, parseBoardReloadCli, parseEmbedCli]) {
    assert.throws(() => parse([]), /--target is required/);
  }
  assert.equal(parseBoardBuildCli(["--target", TARGET]).target, TARGET);
  assert.equal(parseBoardInstallCli(["--target", TARGET]).options.target, TARGET);
  assert.equal(parseBoardReloadCli(["--target", TARGET, "--dry-run"]).target, TARGET);
  assert.equal(parseEmbedCli(["--target", TARGET]).options.target, TARGET);
});

test("generic bundle producers require an explicit board ID", () => {
  assert.throws(() => parseBundleCli(["--entry", "App.tsx", "--out", "build"]), /--board-id is required/);
  const parsed = parseBundleCli(["--entry", "App.tsx", "--out", "build", "--board-id", BOARD_ID]);
  assert.equal(parsed.options.boardId, BOARD_ID);
});

test("board target selection has no profile environment fallback", () => {
  assert.throws(() => parseBoardBuildCli([]), /--target is required/);
  assert.throws(() => parseBoardInstallCli(["--profile", "runtime-probe"]), /unknown option/);
  assert.throws(() => parseBoardReloadCli(["--profile", "runtime-probe"]), /unknown option/);
  assert.throws(() => parseEmbedCli(["--profile", "runtime-probe"]), /unknown option/);
});
