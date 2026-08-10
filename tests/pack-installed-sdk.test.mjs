import assert from "node:assert/strict";
import test from "node:test";

import { DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";
import { DEFAULT_INSTALLED_SDK_PACK_RUNTIME, packInstalledSdk } from "../packages/sdk/dist/project.js";

function runtime({ exists = true, status = 0, stdout = '[{"filename":"sdk.tgz"}]' } = {}) {
  const removed = [];
  const calls = [];
  return {
    removed,
    calls,
    adapter: {
      exists: () => exists,
      makeTemporaryDirectory: () => "/tmp/packed-sdk",
      remove: (path) => removed.push(path),
      run: (...args) => { calls.push(args); return { status, stdout }; },
    },
  };
}

test("installed SDK repacking is deterministic and fail-closed through its narrow process adapter", () => {
  let fake = runtime({ exists: false });
  assert.throws(() => packInstalledSdk("/sdk", fake.adapter), { code: DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND });
  assert.equal(fake.calls.length, 0);
  fake = runtime({ status: 2 });
  assert.throws(() => packInstalledSdk("/sdk", fake.adapter), { code: DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND });
  assert.deepEqual(fake.removed, ["/tmp/packed-sdk"]);
  fake = runtime({ stdout: "not json" });
  assert.throws(() => packInstalledSdk("/sdk", fake.adapter), { code: DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND });
  fake = runtime({ stdout: "[]" });
  assert.throws(() => packInstalledSdk("/sdk", fake.adapter), { code: DIAGNOSTIC_CODES.ARTIFACT_NOT_FOUND });
  fake = runtime();
  assert.equal(packInstalledSdk("/sdk", fake.adapter), "/tmp/packed-sdk/sdk.tgz");
  assert.deepEqual(fake.calls[0], ["npm", ["pack", "/sdk", "--ignore-scripts", "--json", "--pack-destination", "/tmp/packed-sdk"], "/sdk"]);
});

test("default installed-SDK adapter delegates process and temporary filesystem operations", () => {
  assert.equal(DEFAULT_INSTALLED_SDK_PACK_RUNTIME.exists(process.cwd()), true);
  const temporary = DEFAULT_INSTALLED_SDK_PACK_RUNTIME.makeTemporaryDirectory("/tmp/tsx-lvgl-pack-runtime-");
  assert.equal(DEFAULT_INSTALLED_SDK_PACK_RUNTIME.exists(temporary), true);
  const result = DEFAULT_INSTALLED_SDK_PACK_RUNTIME.run(process.execPath, ["-e", "process.stdout.write('ok')"], process.cwd());
  assert.deepEqual(result, { status: 0, stdout: "ok" });
  DEFAULT_INSTALLED_SDK_PACK_RUNTIME.remove(temporary);
  assert.equal(DEFAULT_INSTALLED_SDK_PACK_RUNTIME.exists(temporary), false);
});
