import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageNames = ["core", "sensors", "runtime", "bundler", "device", "sdk"];

/**
 * Emit the instrumented runtime JavaScript without re-emitting declarations.
 *
 * Stryker rewrites string literals into runtime expressions. That is correct
 * for executable mutants, but TypeScript then widens public literal types
 * (for example `Screen` becomes `string`) when it emits declarations. The
 * strict build before Stryker has already validated the declaration contract;
 * preserving that snapshot lets installed-consumer tests exercise the mutated
 * JavaScript without treating instrumentation as a public API change.
 */
export function emitMutationOutput(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const emittedFiles = [];
  for (const packageName of packageNames) {
    const sourceRoot = join(root, "packages", packageName, "src");
    const outputRoot = join(root, "packages", packageName, "dist");
    if (!existsSync(sourceRoot) || !existsSync(outputRoot)) {
      throw new Error(`mutation output requires existing source and dist directories for ${packageName}`);
    }
    for (const sourcePath of listTypeScriptFiles(sourceRoot)) {
      const source = readFileSync(sourcePath, "utf8");
      const output = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          // transpileModule has no package.json-aware module detection, so
          // NodeNext would emit CommonJS here even though every workspace is
          // an ESM package. The checked-in build emits ES modules.
          module: ts.ModuleKind.ESNext,
          // Resolution is not performed by transpileModule; Bundler simply
          // avoids NodeNext's package-aware module-format requirement.
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          sourceMap: true,
          declaration: false,
          declarationMap: false,
          verbatimModuleSyntax: true,
        },
        fileName: sourcePath,
        reportDiagnostics: true,
      });
      const diagnostics = output.diagnostics ?? [];
      if (diagnostics.length > 0) {
        throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost));
      }
      const outputPath = join(outputRoot, relative(sourceRoot, sourcePath).replace(/\.ts$/, ".js"));
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, output.outputText, "utf8");
      if (output.sourceMapText !== undefined) writeFileSync(`${outputPath}.map`, output.sourceMapText, "utf8");
      emittedFiles.push(outputPath);
    }
  }
  return emittedFiles;
}

function listTypeScriptFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

const diagnosticHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => "\n",
};

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const repositoryRoot = resolve(dirname(scriptPath), "..");
  emitMutationOutput(repositoryRoot);
}
