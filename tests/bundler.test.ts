import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  BOARD_ID,
  PROTOCOL_VERSION,
  compileTsxBundle,
  escapeNonAscii,
  renderKernelLoader,
  wrapCjsModule,
} from "@tsx-lvgl/bundler";
import { validateRuntimeBundle } from "@tsx-lvgl/runtime";

const goldenSource = `import { Text } from "@tsx-lvgl/core";
export default function App() {
  return <Text text="hi" />;
}
`;

const goldenCode = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = App;
const jsx_runtime_1 = require("@tsx-lvgl/core/jsx-runtime");
const core_1 = require("@tsx-lvgl/core");
function App() {
    return (0, jsx_runtime_1.jsx)(core_1.Text, { text: "hi" });
}
`;

const goldenSha256 = "95981a5a4b7a507d80f34a52767cc08f7e39b8b3b50cd33e16d7f953cbfd5e94";

test("BOARD_ID and PROTOCOL_VERSION pin the exact board and protocol identifiers", () => {
  assert.equal(BOARD_ID, "waveshare.esp32s3.touch-amoled-1.8");
  assert.equal(PROTOCOL_VERSION, 1);
});

test("compileTsxBundle produces an exact golden code string", () => {
  const output = compileTsxBundle({
    fileName: "App.tsx",
    source: goldenSource,
    bundleId: "app",
    boardId: BOARD_ID,
    generation: 1,
  });
  assert.equal(output.code, goldenCode);
});

test("compileTsxBundle is deterministic across repeated builds", () => {
  const input = {
    fileName: "App.tsx",
    source: goldenSource,
    bundleId: "app",
    boardId: BOARD_ID,
    generation: 1,
  };
  const first = compileTsxBundle(input);
  const second = compileTsxBundle(input);
  assert.deepEqual([...first.bytes], [...second.bytes]);
  assert.deepEqual(first.manifest, second.manifest);
});

test("manifest sha256 matches an independently computed digest and a known vector", () => {
  const output = compileTsxBundle({
    fileName: "App.tsx",
    source: goldenSource,
    bundleId: "app",
    boardId: BOARD_ID,
    generation: 1,
  });
  const independentHash = createHash("sha256").update(Buffer.from(output.bytes)).digest("hex");
  assert.equal(output.manifest.sha256, independentHash);
  assert.equal(output.manifest.sha256, goldenSha256);
});

test("byteLength, bytes.byteLength, and code.length agree for ASCII output", () => {
  const output = compileTsxBundle({
    fileName: "App.tsx",
    source: goldenSource,
    bundleId: "app",
    boardId: BOARD_ID,
    generation: 1,
  });
  assert.equal(output.manifest.byteLength, output.bytes.byteLength);
  assert.equal(output.bytes.byteLength, output.code.length);
});

test("escapeNonAscii passes through 0x7e and 0x7f, escapes 0x80 and above", () => {
  assert.equal(escapeNonAscii("\x7e"), "\x7e");
  assert.equal(escapeNonAscii("\x7f"), "\x7f");
  assert.equal(escapeNonAscii("\x80"), "\\u0080");
  assert.equal(escapeNonAscii("é"), "\\u00E9");
  assert.equal(escapeNonAscii("😀"), "\\uD83D\\uDE00");
});

test("escapeNonAscii round-trips through the JavaScript string-escape grammar", () => {
  const original = "a\x7f\x80é😀b";
  const escaped = escapeNonAscii(original);
  const roundTripped = JSON.parse(`"${escaped}"`) as string;
  assert.equal(roundTripped, original);
});

test("compileTsxBundle emits only ASCII characters for a non-ASCII TSX string literal", () => {
  const output = compileTsxBundle({
    fileName: "App.tsx",
    source: `import { Text } from "@tsx-lvgl/core";
export default function App() {
  return <Text text="héllo 😀" />;
}
`,
    bundleId: "app",
    boardId: BOARD_ID,
    generation: 1,
  });
  for (let index = 0; index < output.code.length; index += 1) {
    assert.ok(output.code.charCodeAt(index) <= 0x7f, `char at ${index} is non-ASCII`);
  }
  assert.match(output.code, /\\u00E9/);
  assert.match(output.code, /\\uD83D\\uDE00/);
});

test("compileTsxBundle throws with the diagnostic text on a syntax error", () => {
  assert.throws(
    () =>
      compileTsxBundle({
        fileName: "Bad.tsx",
        source: "export default function( {",
        bundleId: "app",
        boardId: BOARD_ID,
        generation: 1,
      }),
    /'\}' expected/,
  );
});

test("compileTsxBundle joins multiple diagnostics with the exact prefix and newline separator", () => {
  assert.throws(
    () =>
      compileTsxBundle({
        fileName: "Bad.tsx",
        source: "const a = ;\nconst b = ;",
        bundleId: "app",
        boardId: BOARD_ID,
        generation: 1,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "compileTsxBundle: TSX compilation failed:\nExpression expected.\nExpression expected.",
  );
});

test("compileTsxBundle strips comments from the emitted output", () => {
  const output = compileTsxBundle({
    fileName: "App.tsx",
    source: `import { Text } from "@tsx-lvgl/core";
// hidden
export default function App() {
  return <Text text="hi" />;
}
`,
    bundleId: "app",
    boardId: BOARD_ID,
    generation: 1,
  });
  assert.ok(!output.code.includes("hidden"), "removeComments must strip the source comment");
  assert.equal(output.code, goldenCode);
});

test("compileTsxBundle rejects an empty or whitespace-only bundleId with the exact message", () => {
  assert.throws(
    () =>
      compileTsxBundle({
        fileName: "App.tsx",
        source: goldenSource,
        bundleId: "",
        boardId: BOARD_ID,
        generation: 1,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "compileTsxBundle: bundleId must not be empty or whitespace-only",
  );
  assert.throws(() =>
    compileTsxBundle({
      fileName: "App.tsx",
      source: goldenSource,
      bundleId: "   ",
      boardId: BOARD_ID,
      generation: 1,
    }),
  );
});

test("compileTsxBundle rejects non-positive, fractional, and non-safe-integer generations with the exact message", () => {
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      compileTsxBundle({
        fileName: "App.tsx",
        source: goldenSource,
        bundleId: "app",
        boardId: BOARD_ID,
        generation,
      }),
    );
  }
  assert.throws(
    () =>
      compileTsxBundle({
        fileName: "App.tsx",
        source: goldenSource,
        bundleId: "app",
        boardId: BOARD_ID,
        generation: 0,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "compileTsxBundle: generation must be a positive safe integer, got 0",
  );
  assert.doesNotThrow(() =>
    compileTsxBundle({
      fileName: "App.tsx",
      source: goldenSource,
      bundleId: "app",
      boardId: BOARD_ID,
      generation: 1,
    }),
  );
});

test("compileTsxBundle output passes validateRuntimeBundle under the board policy", () => {
  const output = compileTsxBundle({
    fileName: "App.tsx",
    source: goldenSource,
    bundleId: "app",
    boardId: BOARD_ID,
    generation: 1,
  });
  const policy = {
    protocolVersion: 1,
    engine: "quickjs-ng" as const,
    boardId: BOARD_ID,
    maxBytes: 262144,
    lastGeneration: 0,
  };
  const result = validateRuntimeBundle({ manifest: output.manifest, source: output.bytes }, policy);
  assert.equal(result.ok, true);
});

test("wrapCjsModule emits an exact golden __tsxDefine call", () => {
  const wrapped = wrapCjsModule({ specifier: "@tsx-lvgl/core", code: "exports.x = 1;" });
  assert.equal(
    wrapped,
    '__tsxDefine("@tsx-lvgl/core", function (require, module, exports) {\nexports.x = 1;\n});',
  );
});

test("renderKernelLoader emits an exact golden loader prelude", () => {
  assert.equal(
    renderKernelLoader(),
    '"use strict";\n' +
      "var __tsxModules = {};\n" +
      "var __tsxCache = {};\n" +
      "function __tsxDefine(name, factory) {\n" +
      "  __tsxModules[name] = factory;\n" +
      "}\n" +
      "function __tsxRequire(name) {\n" +
      "  if (Object.prototype.hasOwnProperty.call(__tsxCache, name)) {\n" +
      "    return __tsxCache[name].exports;\n" +
      "  }\n" +
      "  if (!Object.prototype.hasOwnProperty.call(__tsxModules, name)) {\n" +
      '    throw new Error("unknown module: " + name);\n' +
      "  }\n" +
      "  var module = { exports: {} };\n" +
      "  __tsxCache[name] = module;\n" +
      "  __tsxModules[name](__tsxRequire, module, module.exports);\n" +
      "  return module.exports;\n" +
      "}\n",
  );
});

test("the rendered loader memoizes factories and resolves cross-module requires", () => {
  const source =
    renderKernelLoader() +
    wrapCjsModule({
      specifier: "a",
      code: "calls.a += 1; module.exports = { b: require('b') };",
    }) +
    "\n" +
    wrapCjsModule({ specifier: "b", code: "calls.b += 1; module.exports = { value: 42 };" }) +
    "\n" +
    "__tsxRequire('a'); __tsxRequire('a'); return __tsxRequire('a');";
  const run = new Function("calls", source) as (calls: { a: number; b: number }) => unknown;
  const calls = { a: 0, b: 0 };
  const result = run(calls);
  assert.deepEqual(result, { b: { value: 42 } });
  assert.deepEqual(calls, { a: 1, b: 1 });
});

test("the rendered loader throws on an unknown module name", () => {
  const source = `${renderKernelLoader()}return __tsxRequire('missing');`;
  const run = new Function(source) as () => unknown;
  assert.throws(() => run(), /unknown module: missing/);
});
