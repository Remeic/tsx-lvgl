import assert from "node:assert/strict";
import test from "node:test";

import { listSupportedBoards, resolveCanonicalBoardId } from "../packages/sdk/dist/boards.js";
import { DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";

const V1_BOARD_ID = "waveshare.esp32s3.touch-amoled-1.8.v1";
const LEGACY_BOARD_ID = "waveshare.esp32s3.touch-amoled-1.8";

test("board catalog exposes immutable data-only V1 records", () => {
  const boards = listSupportedBoards();
  assert.deepEqual(boards, [{
    id: V1_BOARD_ID,
    displayName: "Waveshare ESP32-S3 Touch AMOLED 1.8 (V1)",
    legacyIds: [LEGACY_BOARD_ID],
  }]);
  assert.equal(Object.isFrozen(boards), true);
  assert.equal(Object.isFrozen(boards[0]), true);
  assert.equal(Object.isFrozen(boards[0].legacyIds), true);
  assert.throws(() => boards.push({ id: "other", displayName: "Other", legacyIds: [] }), TypeError);
  assert.throws(() => { boards[0].id = "other"; }, TypeError);
});

test("canonical resolution accepts only the supported V1 ID", () => {
  assert.equal(resolveCanonicalBoardId(V1_BOARD_ID), V1_BOARD_ID);
});

test("missing board selection is a typed actionable diagnostic", () => {
  for (const value of [undefined, null, ""]) {
    assert.throws(() => resolveCanonicalBoardId(value), (error) => {
      assert.equal(error.code, DIAGNOSTIC_CODES.BOARD_SELECTION_REQUIRED);
      assert.deepEqual(error.details.supportedBoardIds, [V1_BOARD_ID]);
      assert.match(error.message, /tsx-lvgl\.json/);
      assert.match(error.message, /create --board/);
      return true;
    });
  }
});

test("legacy, malformed and unsupported IDs fail without migration", () => {
  for (const value of [LEGACY_BOARD_ID, "waveshare.esp32s3.touch-amoled-1.8.v2", 42]) {
    assert.throws(() => resolveCanonicalBoardId(value), (error) => {
      assert.equal(error.code, DIAGNOSTIC_CODES.BOARD_TARGET_UNSUPPORTED);
      assert.deepEqual(error.details.supportedBoardIds, [V1_BOARD_ID]);
      assert.match(error.message, /Supported canonical IDs/);
      return true;
    });
  }
});
