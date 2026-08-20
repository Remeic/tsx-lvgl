import rawCatalog from "./board-catalog.json" with { type: "json" };

import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";

export type BoardSupportStatus = "supported" | "experimental-build-only";

export interface SupportedBoard {
  readonly id: string;
  readonly displayName: string;
  readonly supportStatus: BoardSupportStatus;
  readonly legacyIds: readonly string[];
}

interface BoardCatalog {
  readonly formatVersion: 1;
  readonly boards: readonly SupportedBoard[];
}

const catalog = freezeCatalog(rawCatalog as BoardCatalog);
const supportedBoardIds = Object.freeze(catalog.boards
  .filter((board) => board.supportStatus === "supported")
  .map((board) => board.id));
const selectionHint = "edit tsx-lvgl.json or pass create --board <canonical-id>";

/** Returns the immutable, data-only catalog exposed to application tooling. */
export function listSupportedBoards(): readonly SupportedBoard[] {
  return catalog.boards;
}

/** Resolves only a canonical catalog ID. Legacy aliases are migration errors. */
export function resolveCanonicalBoardId(value: unknown): string {
  if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
    throw boardSelectionError(
      DIAGNOSTIC_CODES.BOARD_SELECTION_REQUIRED,
      "a canonical board target is required; " + selectionHint,
    );
  }

  if (typeof value !== "string") {
    throw boardSelectionError(
      DIAGNOSTIC_CODES.BOARD_TARGET_UNSUPPORTED,
      `board target must be a canonical string; ${selectionHint}`,
    );
  }

  const canonical = catalog.boards.find((board) => board.id === value);
  if (canonical !== undefined) {
    if (canonical.supportStatus === "supported") return canonical.id;
    throw boardSelectionError(
      DIAGNOSTIC_CODES.BOARD_TARGET_UNSUPPORTED,
      `board target ${JSON.stringify(value)} is ${canonical.supportStatus}; it is build-only and cannot be used by consumer install tooling; ${selectionHint}`,
      canonical.supportStatus,
    );
  }

  const legacy = catalog.boards.find((board) => board.legacyIds.includes(value));
  if (legacy !== undefined) {
    throw boardSelectionError(
      DIAGNOSTIC_CODES.BOARD_TARGET_UNSUPPORTED,
      `legacy board target ${JSON.stringify(value)} is not supported; use ${JSON.stringify(legacy.id)}; ${selectionHint}`,
    );
  }

  throw boardSelectionError(
    DIAGNOSTIC_CODES.BOARD_TARGET_UNSUPPORTED,
    `unsupported board target ${JSON.stringify(value)}; ${selectionHint}`,
  );
}

function boardSelectionError(
  code: typeof DIAGNOSTIC_CODES.BOARD_SELECTION_REQUIRED | typeof DIAGNOSTIC_CODES.BOARD_TARGET_UNSUPPORTED,
  message: string,
  supportStatus?: BoardSupportStatus,
): CliError {
  return new CliError(code, `${message}. Supported canonical IDs: ${supportedBoardIds.join(", ")}`, {
    supportedBoardIds,
    selectionHint,
    ...(supportStatus === undefined ? {} : { supportStatus }),
  });
}

/** Validates and freezes catalog data before it crosses the SDK boundary. */
export function freezeCatalog(value: BoardCatalog): BoardCatalog {
  if (value.formatVersion !== 1 || !Array.isArray(value.boards) || value.boards.length === 0) {
    throw new Error("board catalog must declare formatVersion 1 and at least one board");
  }
  const boards = value.boards.map((board) => {
    if (typeof board.id !== "string" || board.id.length === 0 || typeof board.displayName !== "string" || board.displayName.length === 0) {
      throw new Error("board catalog entries must contain non-empty id and displayName");
    }
    if (board.supportStatus !== "supported" && board.supportStatus !== "experimental-build-only") {
      throw new Error(`unsupported board supportStatus: ${String(board.supportStatus)}`);
    }
    const legacyIds: unknown = board.legacyIds;
    if (!Array.isArray(legacyIds) || legacyIds.some((legacyId: unknown) => typeof legacyId !== "string")) {
      throw new Error(`board ${board.id} must contain a string legacyIds array`);
    }
    return Object.freeze({
      id: board.id,
      displayName: board.displayName,
      supportStatus: board.supportStatus,
      legacyIds: Object.freeze([...legacyIds]),
    });
  });
  return Object.freeze({ formatVersion: 1, boards: Object.freeze(boards) });
}
