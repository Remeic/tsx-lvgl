#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { listFirmwareTargets } from "./board-profile.mjs";

function usage() {
  return "Usage: node scripts/list-board-targets.mjs --firmware [--json]";
}

export function parseCli(argv) {
  let firmware = false;
  let json = false;
  for (const argument of argv) {
    if (argument === "--firmware") {
      if (firmware) throw new Error("--firmware may be supplied only once");
      firmware = true;
    } else if (argument === "--json") {
      if (json) throw new Error("--json may be supplied only once");
      json = true;
    } else if (argument === "--help") {
      return { help: true, firmware, json };
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (!firmware) throw new Error("--firmware is required");
  return { help: false, firmware, json };
}

export function listBoardTargets(options = { firmware: true }) {
  if (!options.firmware) throw new Error("only firmware targets are available");
  return listFirmwareTargets();
}

export function renderBoardTargets(targets, json) {
  if (json) {
    return `${JSON.stringify({ formatVersion: 1, firmware: targets }, null, 2)}\n`;
  }
  return targets.map((target) => `${target.targetKey}\t${target.boardId}\t${target.supportStatus}`).join("\n") + "\n";
}

export function run(argv = process.argv.slice(2), output = console.log) {
  const parsed = parseCli(argv);
  if (parsed.help) {
    output(usage());
    return 0;
  }
  output(renderBoardTargets(listBoardTargets(parsed), parsed.json).trimEnd());
  return 0;
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`list-board-targets: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 2;
  }
}

export { usage };
