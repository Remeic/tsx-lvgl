import assert from "node:assert/strict";
import test from "node:test";

import { buildCommandPlan, parseCli, runCommandPlan } from "../scripts/board-install.mjs";

test("board install requires an explicit target while keeping the Pomodoro entry default", () => {
  assert.throws(() => parseCli([], {}), /--target is required/);
  const parsed = parseCli(["--target", "waveshare-touch-amoled-1.8-v1"], {});
  assert.equal(parsed.options.entry, "examples/apps/pomodoro.tsx");
  assert.equal(parsed.options.bundleId, "pomodoro");
  assert.equal(parsed.options.target, "waveshare-touch-amoled-1.8-v1");
  assert.equal(parsed.options.dryRun, true);
});

test("board install accepts an app shorthand while refusing ambiguous entry selection", () => {
  assert.equal(parseCli(["--app", "pomodoro", "--target", "waveshare-touch-amoled-1.8-v1"], {}).options.entry, "examples/apps/pomodoro.tsx");
  assert.throws(() => parseCli(["--app", "../secret", "--target", "waveshare-touch-amoled-1.8-v1"], {}), /simple app name/);
  assert.throws(() => parseCli(["--entry", "a.tsx", "--app", "b", "--target", "waveshare-touch-amoled-1.8-v1"], {}), /mutually exclusive/);
});

test("persistent install rebuilds the embedded app before delegating to guarded board reload", () => {
  const parsed = parseCli([
    "--app", "pomodoro",
    "--target", "waveshare-touch-amoled-1.8-v1",
    "--bundle-id", "pomodoro",
    "--port", "/dev/cu.usbmodem1101",
    "--recovery-dir", "/tmp/recovery",
    "--esptool-python", "/tmp/esptool-python",
    "--execute",
  ], {});
  const plan = buildCommandPlan(parsed.options);
  assert.deepEqual(plan[0].command, ["npm", "run", "build"]);
  assert.deepEqual(plan[1].command.slice(0, 3), ["node", "scripts/embed-runtime-app.mjs", "--entry"]);
  assert.deepEqual(plan[2].command, ["node", "scripts/build-kernel.mjs"]);
  assert.deepEqual(plan[3].command, ["npm", "run", "board:build", "--", "--target", "waveshare-touch-amoled-1.8-v1"]);
  const reload = plan.at(-1);
  assert.ok(reload);
  assert.deepEqual(reload.command.slice(0, 3), ["npm", "run", "board:reload"]);
  assert.deepEqual(reload.env, { TSX_LVGL_SKIP_BUILD: "1" });
  assert.ok(reload.command.includes("--execute"));
  assert.ok(reload.command.includes("--port"));
  assert.ok(reload.command.includes("/dev/cu.usbmodem1101"));
  assert.ok(reload.command.includes("--recovery-dir"));
  assert.ok(reload.command.includes("--esptool-python"));
  assert.ok(reload.command.includes("--target"));
  assert.ok(reload.command.includes("waveshare-touch-amoled-1.8-v1"));
  assert.ok(!reload.command.includes("idf.py"), "install must delegate writes to board:reload");
});

test("experimental build-only targets are rejected before install planning or execution", () => {
  const parsed = parseCli(["--target", "waveshare-touch-amoled-1.8-v2", "--execute"], {});
  let runnerCalls = 0;
  assert.throws(
    () => runCommandPlan(buildCommandPlan(parsed.options), ".", () => { runnerCalls++; return { status: 0 }; }),
    /experimental-build-only.*board install.*supported/,
  );
  assert.equal(runnerCalls, 0, "unsupported install must not invoke build or reload runners");
});
