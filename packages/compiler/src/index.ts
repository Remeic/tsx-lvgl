import { emitLvgl } from "@tsx-lvgl/lvgl-emitter";
import type { TsxLvglComponent, UiNode } from "@tsx-lvgl/core";

export interface CompileConfig {
  readonly root: TsxLvglComponent;
  readonly projectName?: string;
}

export interface BuildArtifacts {
  readonly files: Readonly<Record<string, string>>;
  readonly manifest: {
    readonly format: "tsx-lvgl-build-artifacts-v0";
    readonly projectName: string;
    readonly source: "tsx";
    readonly target: "lvgl9-c";
  };
}

/**
 * Compile a root component and repeat its evaluation to detect divergent
 * artifacts within one invocation. This check is not a proof that an opaque
 * component is pure across separate compiler invocations; callers must keep
 * roots pure and pin their tool/environment inputs for reproducible builds.
 */
export function compileProject(config: CompileConfig): BuildArtifacts {
  const projectName = config.projectName ?? "tsx-lvgl-project";
  const first = compileRoot(config.root({}), projectName);
  const second = compileRoot(config.root({}), projectName);
  if (first.files["generated/ui.c"] !== second.files["generated/ui.c"]) {
    throw new Error("Root component is not deterministic at root: repeated evaluation produced different artifacts");
  }
  return first;
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
