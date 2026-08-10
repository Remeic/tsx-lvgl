import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DOCTOR_CHECK_IDS, DOCTOR_SUCCESS_CODES } from "../packages/sdk/dist/doctor.js";
import { doctorProject } from "../packages/sdk/dist/project.js";
import { NODE_ENGINE_RANGE } from "../packages/sdk/dist/node-engine.js";
import { validateNodeEngine } from "../packages/sdk/dist/node-engine.js";

test("doctor applies the declared Node SemVer range to injected versions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsx-lvgl-node-engine-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  async function nodeCheck(nodeVersion, nodeRange, sdkRange = NODE_ENGINE_RANGE) {
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "consumer", engines: nodeRange === undefined ? {} : { node: nodeRange } })}\n`,
    );
    await mkdir(join(root, "node_modules", "@tsx-lvgl", "sdk"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "@tsx-lvgl", "sdk", "package.json"),
      `${JSON.stringify({ name: "@tsx-lvgl/sdk", engines: sdkRange === undefined ? {} : { node: sdkRange } })}\n`,
    );
    return doctorProject(root, { nodeVersion }).checks.find((check) => check.id === DOCTOR_CHECK_IDS.CONSUMER_NODE_ENGINE);
  }

  assert.deepEqual(await nodeCheck("24.20.0", NODE_ENGINE_RANGE), {
    id: DOCTOR_CHECK_IDS.CONSUMER_NODE_ENGINE,
    ok: true,
    detail: `Node 24.20.0 satisfies ${NODE_ENGINE_RANGE}`,
    successCode: DOCTOR_SUCCESS_CODES.CONSUMER_NODE_ENGINE_OK,
  });
  assert.deepEqual(await nodeCheck("25.0.0", NODE_ENGINE_RANGE), {
    id: DOCTOR_CHECK_IDS.CONSUMER_NODE_ENGINE,
    ok: false,
    detail: `Node 25.0.0 is outside the configured consumer engine ${NODE_ENGINE_RANGE}`,
    diagnosticCode: "UNSUPPORTED_NODE",
  });
  assert.deepEqual(await nodeCheck("24.19.0", undefined), {
    id: DOCTOR_CHECK_IDS.CONSUMER_NODE_ENGINE,
    ok: false,
    detail: "package.json must declare an engines.node SemVer range",
    diagnosticCode: "NODE_ENGINE_MISSING",
  });
  assert.deepEqual(await nodeCheck("24.19.0", "not a range"), {
    id: DOCTOR_CHECK_IDS.CONSUMER_NODE_ENGINE,
    ok: false,
    detail: "package.json engines.node must be a valid SemVer range",
    diagnosticCode: "NODE_ENGINE_INVALID",
  });

  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "consumer", engines: { node: NODE_ENGINE_RANGE } })}\n`);
  await writeFile(join(root, "node_modules", "@tsx-lvgl", "sdk", "package.json"), `${JSON.stringify({ name: "@tsx-lvgl/sdk", engines: { node: ">=25" } })}\n`);
  assert.deepEqual(
    doctorProject(root, { nodeVersion: "24.19.0" }).checks.find((check) => check.id === DOCTOR_CHECK_IDS.SDK_NODE_ENGINE),
    {
      id: DOCTOR_CHECK_IDS.SDK_NODE_ENGINE,
      ok: false,
      detail: "Node 24.19.0 is outside the configured sdk engine >=25",
      diagnosticCode: "SDK_UNSUPPORTED_NODE",
    },
  );
});

test("Node contract diagnostics distinguish every SDK and consumer declaration failure", () => {
  for (const [subject, code] of [["consumer", "NODE_ENGINE_MISSING"], ["sdk", "SDK_NODE_ENGINE_MISSING"]]) {
    assert.throws(() => validateNodeEngine({}, "24.19.0", subject), { code });
  }
  for (const [subject, code] of [["consumer", "NODE_ENGINE_INVALID"], ["sdk", "SDK_NODE_ENGINE_INVALID"]]) {
    assert.throws(() => validateNodeEngine({ engines: { node: "not a range" } }, "24.19.0", subject), { code });
  }
  assert.throws(() => validateNodeEngine({ engines: [] }, "24.19.0"), { code: "NODE_ENGINE_MISSING" });
});
