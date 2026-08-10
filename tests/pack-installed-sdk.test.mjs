import assert from "node:assert/strict";
import test from "node:test";

import { DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";
import { packInstalledSdk } from "../packages/sdk/dist/project.js";

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
