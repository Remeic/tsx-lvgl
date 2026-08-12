import assert from "node:assert/strict";
import test from "node:test";

import { buildCommandPlan, parseCli } from "../scripts/board-install.mjs";

test("board install defaults to the persistent Pomodoro app and a dry run", () => {
  const parsed = parseCli([], {});
  assert.deepEqual(parsed, {
    help: false,
    options: {
      entry: "examples/apps/pomodoro.tsx",
      bundleId: "pomodoro",
      profile: "runtime-probe",
      port: "",
      recoveryDir: "",
      esptoolPython: "",
      resetMode: "watchdog-reset",
      execute: false,
      dryRun: true,
    },
  });
});

test("board install accepts an app shorthand while refusing ambiguous entry selection", () => {
  assert.equal(parseCli(["--app", "pomodoro"], {}).options.entry, "examples/apps/pomodoro.tsx");
  assert.throws(() => parseCli(["--app", "../secret"], {}), /simple app name/);
  assert.throws(() => parseCli(["--entry", "a.tsx", "--app", "b"], {}), /mutually exclusive/);
});

test("persistent install rebuilds the embedded app before delegating to guarded board reload", () => {
  const parsed = parseCli([
    "--app", "pomodoro",
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
  assert.deepEqual(plan[3].command, ["npm", "run", "board:build"]);
  const reload = plan.at(-1);
  assert.ok(reload);
  assert.deepEqual(reload.command.slice(0, 3), ["npm", "run", "board:reload"]);
  assert.deepEqual(reload.env, { TSX_LVGL_SKIP_BUILD: "1" });
  assert.ok(reload.command.includes("--execute"));
  assert.ok(reload.command.includes("--port"));
  assert.ok(reload.command.includes("/dev/cu.usbmodem1101"));
  assert.ok(reload.command.includes("--recovery-dir"));
  assert.ok(reload.command.includes("--esptool-python"));
  assert.ok(reload.command.includes("--profile"));
  assert.ok(!reload.command.includes("idf.py"), "install must delegate writes to board:reload");
});
