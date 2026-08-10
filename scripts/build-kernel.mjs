import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { escapeNonAscii, renderKernelLoader, wrapCjsModule } from "@tsx-lvgl/bundler";

import { readFlagValue } from "./lib/cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Fixed emit order: byte-deterministic, not a dependency requirement (requires resolve lazily). */
const PACKAGES = ["core", "capabilities", "sensors", "runtime", "device"];

const DEFAULT_OUT = resolve(ROOT, "examples/esp-idf/runtime_port_probe/main/kernel.js");

const ALIASES = [
  { specifier: "@tsx-lvgl/core", target: "@tsx-lvgl/core/index.js" },
  { specifier: "@tsx-lvgl/capabilities", target: "@tsx-lvgl/capabilities/index.js" },
  { specifier: "@tsx-lvgl/sensors", target: "@tsx-lvgl/sensors/index.js" },
  { specifier: "@tsx-lvgl/runtime", target: "@tsx-lvgl/runtime/index.js" },
  { specifier: "@tsx-lvgl/device", target: "@tsx-lvgl/device/index.js" },
  { specifier: "@tsx-lvgl/core/jsx-runtime", target: "@tsx-lvgl/core/jsx-runtime.js" },
];

const INTRA_PACKAGE_REQUIRE_RE = /require\("\.\/([\w.-]+)\.js"\)/g;
const UNREWRITTEN_RELATIVE_REQUIRE_RE = /require\(["']\.\.?\//;

const BOOT_GLUE = `var __tsxKernel = null;
globalThis.__tsxKernelBoot = function (manifestJson, sourceText) {
  var device = __tsxRequire("@tsx-lvgl/device");
  __tsxKernel = device.createKernel(globalThis.__native);
  var bytes = device.encodeAsciiSource(sourceText);
  if (bytes === null) throw new Error("kernel boot: non-ascii source");
  __tsxKernel.start({ manifest: JSON.parse(manifestJson), source: bytes });
};
globalThis.__tsxKernelReload = function (manifestJson, sourceText) {
  if (__tsxKernel === null) return "rejected kernel-not-started";
  return __tsxKernel.stageReload(manifestJson, sourceText);
};
globalThis.__tsxKernelPump = function () { if (__tsxKernel !== null) __tsxKernel.pump(); };
globalThis.__tsxKernelLastGeneration = function () { return __tsxKernel === null ? 0 : __tsxKernel.lastGeneration(); };
`;

function usage() {
  return `Usage:
  node scripts/build-kernel.mjs [--out <path>]

Options:
  --out PATH   Kernel output path (default: ${DEFAULT_OUT}).
  --help       Show this help.
`;
}

function parseCli(argv) {
  let out = DEFAULT_OUT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };

    const [name] = argument.split("=", 2);
    if (name !== "--out") throw new Error(`unknown option: ${argument}`);
    const { value, nextIndex } = readFlagValue(argv, index);
    index = nextIndex;
    out = resolve(value);
  }
  return { help: false, out };
}

/**
 * Compiles every `.ts` file in `packages/<pkgName>/src` with the TypeScript
 * compiler API, one file at a time, and rewrites the emitted CJS's
 * intra-package relative `require`s into kernel-loader specifiers
 * (`@tsx-lvgl/<pkgName>/<file>.js`). Cross-package requires (bare
 * specifiers, e.g. `require("@tsx-lvgl/core")`) are left untouched — the
 * kernel loader registers those directly.
 */
function compilePackage(pkgName) {
  const srcDir = resolve(ROOT, "packages", pkgName, "src");
  const files = readdirSync(srcDir)
    .filter((file) => file.endsWith(".ts"))
    .sort();

  return files.map((file) => {
    const filePath = resolve(srcDir, file);
    const source = readFileSync(filePath, "utf8");
    const transpiled = ts.transpileModule(source, {
      fileName: filePath,
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        newLine: ts.NewLineKind.LineFeed,
        removeComments: true,
      },
    });

    if (transpiled.diagnostics && transpiled.diagnostics.length > 0) {
      const messages = transpiled.diagnostics
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("\n");
      throw new Error(`build-kernel: compiling ${pkgName}/${file} failed:\n${messages}`);
    }

    const rewritten = transpiled.outputText.replace(
      INTRA_PACKAGE_REQUIRE_RE,
      (_match, name) => `require(${JSON.stringify(`@tsx-lvgl/${pkgName}/${name}.js`)})`,
    );

    if (UNREWRITTEN_RELATIVE_REQUIRE_RE.test(rewritten)) {
      throw new Error(
        `build-kernel: ${pkgName}/${file} emitted a relative require the rewrite regex didn't match ` +
          `(expected require("./<name>.js")); fix the pattern or the source before regenerating the kernel.`,
      );
    }

    const specifier = `@tsx-lvgl/${pkgName}/${file.replace(/\.ts$/, ".js")}`;
    return { specifier, code: rewritten };
  });
}

function buildAliasModules() {
  return ALIASES.map(({ specifier, target }) => ({
    specifier,
    code: `module.exports = require(${JSON.stringify(target)});`,
  }));
}

function assembleKernel(modules) {
  const header = [
    "// GENERATED by scripts/build-kernel.mjs — do not edit.",
    "// Source packages: core, capabilities, sensors, runtime, device (packages/*/src).",
    "//",
    "// Define order below is irrelevant: __tsxRequire resolves modules lazily",
    "// at call time, not at define time. Packages are emitted in a fixed order",
    "// (core, sensors, runtime, device, then aliases) purely for byte determinism.",
  ].join("\n");

  const parts = [header, renderKernelLoader(), ...modules.map(wrapCjsModule), BOOT_GLUE];
  return parts.join("\n");
}

function build() {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(`build-kernel: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exit(2);
  }

  if (parsed.help) {
    console.log(usage());
    return;
  }

  const packageModules = PACKAGES.flatMap(compilePackage);
  const aliasModules = buildAliasModules();
  const allModules = [...packageModules, ...aliasModules];

  const assembled = assembleKernel(allModules);
  const escaped = escapeNonAscii(assembled);
  for (let index = 0; index < escaped.length; index += 1) {
    if (escaped.charCodeAt(index) > 0x7f) {
      throw new Error(`build-kernel: non-ascii char survived escaping at offset ${index}`);
    }
  }

  const final = escaped.endsWith("\n") ? escaped : `${escaped}\n`;
  mkdirSync(dirname(parsed.out), { recursive: true });
  writeFileSync(parsed.out, final, "ascii");

  console.log(`build-kernel: wrote ${parsed.out}`);
  console.log(`build-kernel: ${Buffer.byteLength(final, "ascii")} bytes, ${allModules.length} modules`);
}

build();
