import { emitLvgl } from "@tsx-lvgl/lvgl-emitter";
import type { TsxLvglComponent, UiNode } from "@tsx-lvgl/core";
import { emitNativeProgram } from "./native-emitter.js";
import { compileSourceToProgram, type SourceCompileConfig, SourceCompileError } from "./source.js";

export { SourceCompileError } from "./source.js";
export interface LegacyCompileConfig {
  readonly root: TsxLvglComponent;
  readonly projectName?: string;
  readonly entryFile?: never;
}

export interface SourceEntryCompileConfig extends SourceCompileConfig {
  readonly projectName?: string;
  readonly root?: never;
}

/** The exclusive legacy-root or source-entry compiler configuration. */
export type CompileConfig = LegacyCompileConfig | SourceEntryCompileConfig;

export interface BuildArtifacts {
  readonly files: Readonly<Record<string, string>>;
  readonly manifest: {
    readonly format: "tsx-lvgl-build-artifacts-v0";
    readonly projectName: string;
    readonly source: "tsx";
    readonly target: "lvgl9-c";
    readonly compiler?: "react-mvp-v0";
    readonly lvgl?: "9.5.0";
  };
}

/**
 * Compile a root component and repeat its evaluation to detect divergent
 * artifacts within one invocation. This check is not a proof that an opaque
 * component is pure across separate compiler invocations; callers must keep
 * roots pure and pin their tool/environment inputs for reproducible builds.
 */
export function compileProject(config: CompileConfig): BuildArtifacts {
  if (config.entryFile !== undefined) return compileSourceEntry(config);
  const projectName = config.projectName ?? "tsx-lvgl-project";
  const first = compileRoot(config.root({}), projectName);
  const second = compileRoot(config.root({}), projectName);
  if (first.files["generated/ui.c"] !== second.files["generated/ui.c"]) {
    throw new Error("Root component is not deterministic at root: repeated evaluation produced different artifacts");
  }
  return first;
}

function compileSourceEntry(config: SourceEntryCompileConfig): BuildArtifacts {
  const first = compileSourceToProgram(config);
  const firstC = emitNativeProgram(first.program);
  const second = compileSourceToProgram(config);
  const secondC = emitNativeProgram(second.program);
  if (firstC !== secondC) {
    throw new SourceCompileError(config.entryFile, 1, 1, "source compilation was not deterministic");
  }
  const projectName = config.projectName ?? "tsx-lvgl-project";
  const manifest = {
    format: "tsx-lvgl-build-artifacts-v0" as const,
    projectName,
    source: "tsx" as const,
    target: "lvgl9-c" as const,
    compiler: "react-mvp-v0" as const,
    lvgl: "9.5.0" as const,
  };
  return {
    files: {
      "generated/ui.c": firstC,
      "generated/manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    },
    manifest,
  };
}

function compileRoot(root: UiNode, projectName: string): BuildArtifacts {
  const uiC = emitLvgl(root);

  const manifest = {
    format: "tsx-lvgl-build-artifacts-v0" as const,
    projectName,
    source: "tsx" as const,
    target: "lvgl9-c" as const,
  };

  return {
    files: {
      "generated/ui.c": uiC,
      "generated/manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    },
    manifest,
  };
}
