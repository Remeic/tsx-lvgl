#!/usr/bin/env node
/**
 * Console demo/verification runner for the bundler -> kernel -> reload path.
 * Compiles a real TSX app with `compileTsxBundle`, mounts it on a real
 * `createKernel` wired to a small in-memory (console) native ABI, and drives
 * it through a few deterministic steps: initial render, an optional shake,
 * an optional hot reload, and an optional pair of failure-mode reloads
 * (corrupted bytes, then a throwing bundle).
 *
 * Usage:
 *   node scripts/run-host.mjs --entry <path.tsx> [--shake] [--reload <pathB.tsx>] [--corrupt]
 *
 * Exit code is 0 when every exercised outcome matched what was expected, 1
 * otherwise. Every device-side log line is prefixed "device: ".
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { BOARD_ID, compileTsxBundle } from "@tsx-lvgl/bundler";
import { MemoryBoardAdapter, createDefaultBoardDescriptors, createKernel, encodeBoardPayload } from "@tsx-lvgl/device";

const STEP_PERIOD_MS = 80;
const STEP_COUNT = 5;
const SHAKE_STEP = 3;

const CALM_MOTION = { accelerationMps2: [0, 0, 9.80665], angularVelocityDps: [0, 0, 0] };
const SHAKE_MOTION = { accelerationMps2: [30, 0, 0], angularVelocityDps: [0, 0, 0] };

function usage() {
  return `Usage:
  node scripts/run-host.mjs --entry <path.tsx> [--shake] [--reload <pathB.tsx>] [--corrupt]

Options:
  --entry PATH     TSX app to compile as generation 1 (required).
  --shake          Inject one above-threshold motion reading mid-run.
  --reload PATH    Compile PATH as generation 2 and stage it as a hot reload.
  --corrupt        Stage a byte-corrupted reload (expect rejected), then a
                    throwing bundle (expect rolled_back).
`;
}

function parseCli(argv) {
  const options = { entry: undefined, shake: false, reload: undefined, corrupt: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--shake") {
      options.shake = true;
      continue;
    }
    if (argument === "--corrupt") {
      options.corrupt = true;
      continue;
    }
    if (argument === "--entry") {
      options.entry = argv[++index];
      continue;
    }
    if (argument === "--reload") {
      options.reload = argv[++index];
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (!options.entry) throw new Error("--entry <path.tsx> is required");
  return options;
}

// ---------------------------------------------------------------------------
// Console native ABI: an in-memory widget tree, manual interval timers, and a
// scripted motion sensor. Every method here is a direct implementation of
// `NativeBindings` from packages/device/src/native.ts.
// ---------------------------------------------------------------------------

function createConsoleNative() {
  const nodes = new Map();
  let nextId = 1;
  let loadedScreen = 0;
  const clickableIds = new Set();

  const lvgl = {
    create(kind) {
      const id = nextId++;
      nodes.set(id, { id, kind, text: undefined, parent: null, children: [] });
      return id;
    },
    insert(parent, child, index) {
      const parentNode = nodes.get(parent);
      const childNode = nodes.get(child);
      detach(childNode);
      const bounded = Math.max(0, Math.min(index, parentNode.children.length));
      parentNode.children.splice(bounded, 0, child);
      childNode.parent = parent;
    },
    setText(id, text) {
      nodes.get(id).text = text;
    },
    setClickable(id, clickable) {
      if (clickable) clickableIds.add(id);
      else clickableIds.delete(id);
    },
    remove(parent, child) {
      const parentNode = nodes.get(parent);
      const index = parentNode.children.indexOf(child);
      if (index >= 0) parentNode.children.splice(index, 1);
      nodes.get(child).parent = null;
    },
    dispose(id) {
      const node = nodes.get(id);
      if (node === undefined) return;
      for (const child of [...node.children]) lvgl.dispose(child);
      nodes.delete(id);
    },
    loadScreen(id) {
      loadedScreen = id;
    },
  };

  function detach(node) {
    if (node.parent === null) return;
    const parentNode = nodes.get(node.parent);
    const index = parentNode.children.indexOf(node.id);
    if (index >= 0) parentNode.children.splice(index, 1);
    node.parent = null;
  }

  let nextHandle = 1;
  const timers = new Map();
  const timerNative = {
    setInterval(cb, periodMs) {
      const handle = nextHandle++;
      timers.set(handle, { cb, periodMs, elapsedMs: 0 });
      return handle;
    },
    clearInterval(handle) {
      timers.delete(handle);
    },
    advance(ms) {
      for (const timer of timers.values()) {
        timer.elapsedMs += ms;
        while (timer.elapsedMs >= timer.periodMs) {
          timer.elapsedMs -= timer.periodMs;
          timer.cb();
        }
      }
    },
  };

  let currentReading = { status: "ok", sampledAtMs: 0, value: CALM_MOTION };
  const sensors = {
    read() {
      return currentReading;
    },
    script(reading) {
      currentReading = reading;
    },
  };

  const board = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });

  let clickDispatch;
  const native = {
    boardId: BOARD_ID,
    lvgl,
    timers: timerNative,
    sensors,
    board,
    onClick(dispatch) {
      clickDispatch = dispatch;
    },
    log(message) {
      console.log(`device: ${message}`);
    },
  };

  return {
    native,
    timers: timerNative,
    sensors,
    board,
    dispatchClick(id) {
      clickDispatch?.(id);
    },
    firstButtonId() {
      return [...clickableIds].find((id) => nodes.get(id)?.kind === "button");
    },
    emitMotion(reading) {
      const request = board.submitted.at(-1);
      if (request === undefined) throw new Error("motion observation was not started");
      const status = reading.status === "ok" ? "ok" : reading.status;
      board.emit({
        version: 1,
        kind: "state",
        handle: board.submitted.length,
        reloadEpoch: request.reloadEpoch,
        sequence: Math.max(1, Math.round(reading.sampledAtMs) + 1),
        observedAtMs: reading.sampledAtMs,
        payload: encodeBoardPayload({
          status,
          schemaVersion: 1,
          ...(reading.value === undefined ? {} : { value: reading.value }),
          ...(status === "ok" || status === "stale"
            ? {}
            : { issue: { code: "not-ready", retry: "automatic", diagnosticId: "console-motion" } }),
        }),
      });
    },
    treeLines() {
      const lines = [];
      if (loadedScreen === 0) {
        lines.push("(blank)");
        return lines;
      }
      renderNode(loadedScreen, 0, lines);
      return lines;
    },
    treeTexts() {
      const texts = [];
      collectTexts(loadedScreen, texts);
      return texts;
    },
  };

  function renderNode(id, depth, lines) {
    const node = nodes.get(id);
    if (node === undefined) return;
    const indent = "  ".repeat(depth);
    const label = node.kind === "text" || node.kind === "button" ? `${node.kind}: ${node.text}` : node.kind;
    lines.push(`${indent}${label}`);
    for (const child of node.children) renderNode(child, depth + 1, lines);
  }

  function collectTexts(id, out) {
    const node = nodes.get(id);
    if (node === undefined) return;
    if (node.text !== undefined) out.push(node.text);
    for (const child of node.children) collectTexts(child, out);
  }
}

function printTree(label, host) {
  console.log(`device: tree (${label}):`);
  for (const line of host.treeLines()) console.log(`device:   ${line}`);
}

function compileFile(path, bundleId, generation) {
  const fileName = basename(path);
  const source = readFileSync(resolve(path), "utf8");
  return compileTsxBundle({ fileName, source, bundleId, boardId: BOARD_ID, generation });
}

function toRuntimeBundle(output) {
  return { manifest: output.manifest, source: output.bytes };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const host = createConsoleNative();
  const kernel = createKernel(host.native);
  const counterMode = basename(options.entry).toLowerCase() === "counter.tsx";
  const bundleId = counterMode ? "counter" : "shakeface";
  let ok = true;
  let nextGeneration = 2;

  function check(description, condition) {
    console.log(`device: ${condition ? "PASS" : "FAIL"} - ${description}`);
    if (!condition) ok = false;
  }

  // -- initial mount (generation 1) -----------------------------------------
  host.sensors.script({ status: "ok", sampledAtMs: 0, value: CALM_MOTION });
  const bundleA = compileFile(options.entry, bundleId, 1);
  kernel.start(toRuntimeBundle(bundleA));
  printTree("after start", host);

  // Let the initial sensor read (a Promise) settle, then drain the re-render.
  await Promise.resolve();
  await Promise.resolve();
  host.emitMotion({ status: "ok", sampledAtMs: 0, value: CALM_MOTION });
  kernel.pump();
  printTree("after initial sensor settle", host);

  const initialTexts = host.treeTexts();
  console.log(`device: initial texts = ${JSON.stringify(initialTexts)}`);
  if (counterMode) {
    check("Counter mounted with count zero", initialTexts.includes("count=0"));
    check("Counter motion settled to STILL", initialTexts.includes("motion=STILL"));
    const incrementButton = host.firstButtonId();
    check("Counter exposes a clickable increment action", incrementButton !== undefined);
    if (incrementButton !== undefined) {
      host.dispatchClick(incrementButton);
      kernel.pump();
      check("touch dispatch increments Counter", host.treeTexts().includes("count=1"));
    }
  }

  // -- step loop, optionally injecting one shake ----------------------------
  let sawMotionChange = false;
  for (let step = 1; step <= STEP_COUNT; step += 1) {
    const shakeNow = options.shake && step === SHAKE_STEP;
    host.sensors.script({
      status: "ok",
      sampledAtMs: step * STEP_PERIOD_MS,
      value: shakeNow ? SHAKE_MOTION : CALM_MOTION,
    });
    host.emitMotion({
      status: "ok",
      sampledAtMs: step * STEP_PERIOD_MS,
      value: shakeNow ? SHAKE_MOTION : CALM_MOTION,
    });
    host.timers.advance(STEP_PERIOD_MS);
    kernel.pump();
    const texts = host.treeTexts();
    console.log(`device: step ${step}${shakeNow ? " (shake)" : ""} texts = ${JSON.stringify(texts)}`);
    if (counterMode) {
      if (shakeNow && texts.includes("motion=SHAKE")) sawMotionChange = true;
    } else if (texts.some((text) => text.includes("/----\\"))) {
      sawMotionChange = true;
    }
  }
  printTree("after step loop", host);

  if (options.shake) {
    check(counterMode ? "shaking changed the Counter motion state" : "shaking flipped the mouth to the sad glyph", sawMotionChange);
  }

  // -- hot reload ------------------------------------------------------------
  if (options.reload) {
    const generation = nextGeneration++;
    const bundleB = compileFile(options.reload, bundleId, generation);
    const result = kernel.stageReload(JSON.stringify(bundleB.manifest), bundleB.code);
    console.log(`device: stageReload(${options.reload}) -> ${result}`);
    printTree("after reload", host);
    const texts = host.treeTexts();
    check(`stageReload committed generation ${generation}`, result === `committed ${generation}`);
    if (!counterMode) {
      check("reloaded tree shows a variant-B mouth glyph", texts.some((text) => text === "^----^" || text === "v----v"));
    }
  }

  // -- failure modes: corrupted bytes, then a throwing bundle -----------------
  if (options.corrupt) {
    const beforeCorruptTexts = host.treeTexts();

    const corruptTarget = options.reload ?? options.entry;
    const corruptGeneration = nextGeneration++;
    const corruptBundle = compileFile(corruptTarget, bundleId, corruptGeneration);
    const truncatedCode = corruptBundle.code.slice(0, Math.floor(corruptBundle.code.length / 2));
    const corruptResult = kernel.stageReload(JSON.stringify(corruptBundle.manifest), truncatedCode);
    console.log(`device: stageReload(corrupted bytes) -> ${corruptResult}`);
    check("corrupted bytes were rejected", corruptResult.startsWith("rejected"));
    check("tree is unchanged after a rejected reload", sameTexts(host.treeTexts(), beforeCorruptTexts));

    const throwingSource = `export default function Boom() {\n  throw new Error("boom");\n}\n`;
    const throwGeneration = nextGeneration++;
    const throwingBundle = compileTsxBundle({
      fileName: "Boom.tsx",
      source: throwingSource,
      bundleId,
      boardId: BOARD_ID,
      generation: throwGeneration,
    });
    const throwResult = kernel.stageReload(JSON.stringify(throwingBundle.manifest), throwingBundle.code);
    console.log(`device: stageReload(throwing bundle) -> ${throwResult}`);
    printTree("after rolled-back reload", host);
    check("a throwing candidate rolled back", throwResult === "rolled_back");
    check("tree is unchanged after a rollback", sameTexts(host.treeTexts(), beforeCorruptTexts));
  }

  console.log(`device: ${ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  process.exit(ok ? 0 : 1);
}

function sameTexts(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

main().catch((error) => {
  console.error(`device: fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
