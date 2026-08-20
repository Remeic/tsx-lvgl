import assert from "node:assert/strict";
import test from "node:test";

import { freezeCatalog, listSupportedBoards, resolveCanonicalBoardId } from "../packages/sdk/dist/boards.js";
import { DIAGNOSTIC_CODES } from "../packages/sdk/dist/diagnostics.js";

const V1_BOARD_ID = "waveshare.esp32s3.touch-amoled-1.8.v1";
const V2_BOARD_ID = "waveshare.esp32s3.touch-amoled-1.8.v2";
const LEGACY_BOARD_ID = "waveshare.esp32s3.touch-amoled-1.8";

test("board catalog exposes immutable V1 and build-only V2 records", () => {
  const boards = listSupportedBoards();
  assert.deepEqual(boards, [{
    id: V1_BOARD_ID,
    displayName: "Waveshare ESP32-S3 Touch AMOLED 1.8 (V1)",
    supportStatus: "supported",
    legacyIds: [LEGACY_BOARD_ID],
  }, {
    id: V2_BOARD_ID,
    displayName: "Waveshare ESP32-S3 Touch AMOLED 1.8 (V2)",
    supportStatus: "experimental-build-only",
    legacyIds: [],
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

test("legacy, experimental and malformed IDs fail without migration", () => {
  for (const value of [LEGACY_BOARD_ID, V2_BOARD_ID, 42, "unknown-board"]) {
    assert.throws(() => resolveCanonicalBoardId(value), (error) => {
      assert.equal(error.code, DIAGNOSTIC_CODES.BOARD_TARGET_UNSUPPORTED);
      assert.deepEqual(error.details.supportedBoardIds, [V1_BOARD_ID]);
      assert.match(error.message, /Supported canonical IDs/);
      if (value === V2_BOARD_ID) assert.equal(error.details.supportStatus, "experimental-build-only");
      return true;
    });
  }
});

test("board catalog rejects every malformed catalog shape before exposing records", () => {
  const malformedCatalogs = [
    [{ formatVersion: 2, boards: [] }, /board catalog must declare formatVersion 1 and at least one board/],
    [{ formatVersion: 1, boards: null }, /board catalog must declare formatVersion 1 and at least one board/],
    [{ formatVersion: 1, boards: [] }, /board catalog must declare formatVersion 1 and at least one board/],
    [{ formatVersion: 1, boards: [{ id: 42, displayName: "Board", supportStatus: "supported", legacyIds: [] }] }, /board catalog entries must contain non-empty id and displayName/],
    [{ formatVersion: 1, boards: [{ id: "", displayName: "Board", supportStatus: "supported", legacyIds: [] }] }, /board catalog entries must contain non-empty id and displayName/],
    [{ formatVersion: 1, boards: [{ id: V1_BOARD_ID, displayName: 42, supportStatus: "supported", legacyIds: [] }] }, /board catalog entries must contain non-empty id and displayName/],
    [{ formatVersion: 1, boards: [{ id: V1_BOARD_ID, displayName: "", supportStatus: "supported", legacyIds: [] }] }, /board catalog entries must contain non-empty id and displayName/],
    [{ formatVersion: 1, boards: [{ id: V1_BOARD_ID, displayName: "Board", supportStatus: "unknown", legacyIds: [] }] }, /unsupported board supportStatus: unknown/],
    [{ formatVersion: 1, boards: [{ id: V1_BOARD_ID, displayName: "Board", supportStatus: "supported", legacyIds: null }] }, /must contain a string legacyIds array/],
    [{ formatVersion: 1, boards: [{ id: V1_BOARD_ID, displayName: "Board", supportStatus: "supported", legacyIds: [42] }] }, /must contain a string legacyIds array/],
  ];

  for (const [catalog, expectedError] of malformedCatalogs) {
    assert.throws(() => freezeCatalog(catalog), expectedError);
  }
});

test("board catalog freezes a valid custom record", () => {
  const boards = freezeCatalog({
    formatVersion: 1,
    boards: [{
      id: "custom-board",
      displayName: "Custom Board",
      supportStatus: "experimental-build-only",
      legacyIds: ["legacy-custom-board"],
    }],
  });

  assert.deepEqual(boards, {
    formatVersion: 1,
    boards: [{
      id: "custom-board",
      displayName: "Custom Board",
      supportStatus: "experimental-build-only",
      legacyIds: ["legacy-custom-board"],
    }],
  });
  assert.equal(Object.isFrozen(boards), true);
  assert.equal(Object.isFrozen(boards.boards), true);
  assert.equal(Object.isFrozen(boards.boards[0]), true);
  assert.equal(Object.isFrozen(boards.boards[0].legacyIds), true);
});
