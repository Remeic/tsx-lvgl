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
import { createKernel } from "@tsx-lvgl/device";

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
    setClickable() {
      // Not rendered in the ASCII tree; no state needed for this demo.
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

  let clickDispatch;
  const native = {
    boardId: BOARD_ID,
    lvgl,
    timers: timerNative,
    sensors,
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
    dispatchClick(id) {
      clickDispatch?.(id);
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
  let ok = true;
  let nextGeneration = 2;

  function check(description, condition) {
    console.log(`device: ${condition ? "PASS" : "FAIL"} - ${description}`);
    if (!condition) ok = false;
  }

  // -- initial mount (generation 1) -----------------------------------------
  host.sensors.script({ status: "ok", sampledAtMs: 0, value: CALM_MOTION });
  const bundleA = compileFile(options.entry, "shakeface", 1);
  kernel.start(toRuntimeBundle(bundleA));
  printTree("after start", host);

  // Let the initial sensor read (a Promise) settle, then drain the re-render.
  await Promise.resolve();
  await Promise.resolve();
  kernel.pump();
  printTree("after initial sensor settle", host);

  const initialTexts = host.treeTexts();
  console.log(`device: initial texts = ${JSON.stringify(initialTexts)}`);

  // -- step loop, optionally injecting one shake ----------------------------
  let sawSadFace = false;
  for (let step = 1; step <= STEP_COUNT; step += 1) {
    const shakeNow = options.shake && step === SHAKE_STEP;
    host.sensors.script({
      status: "ok",
      sampledAtMs: step * STEP_PERIOD_MS,
      value: shakeNow ? SHAKE_MOTION : CALM_MOTION,
    });
    host.timers.advance(STEP_PERIOD_MS);
    kernel.pump();
    const texts = host.treeTexts();
    console.log(`device: step ${step}${shakeNow ? " (shake)" : ""} texts = ${JSON.stringify(texts)}`);
    if (texts.some((text) => text.includes("/----\\"))) sawSadFace = true;
  }
  printTree("after step loop", host);

  if (options.shake) {
    check("shaking flipped the mouth to the sad glyph", sawSadFace);
  }

  // -- hot reload ------------------------------------------------------------
  if (options.reload) {
    const generation = nextGeneration++;
    const bundleB = compileFile(options.reload, "shakeface", generation);
    const result = kernel.stageReload(JSON.stringify(bundleB.manifest), bundleB.code);
    console.log(`device: stageReload(${options.reload}) -> ${result}`);
    printTree("after reload", host);
    const texts = host.treeTexts();
    check(`stageReload committed generation ${generation}`, result === `committed ${generation}`);
    check("reloaded tree shows a variant-B mouth glyph", texts.some((text) => text === "^----^" || text === "v----v"));
  }

  // -- failure modes: corrupted bytes, then a throwing bundle -----------------
  if (options.corrupt) {
    const beforeCorruptTexts = host.treeTexts();

    const corruptTarget = options.reload ?? options.entry;
    const corruptGeneration = nextGeneration++;
    const corruptBundle = compileFile(corruptTarget, "shakeface", corruptGeneration);
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
      bundleId: "shakeface",
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
