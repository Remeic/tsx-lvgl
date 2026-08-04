import { emitLvgl } from "@lume/lvgl-emitter";
import type { LumeComponent, UiNode } from "@lume/core";

export interface CompileConfig {
  readonly root: LumeComponent;
  readonly projectName?: string;
}

export interface BuildArtifacts {
  readonly files: Readonly<Record<string, string>>;
  readonly manifest: {
    readonly format: "lume-build-artifacts-v0";
    readonly projectName: string;
    readonly source: "tsx";
    readonly target: "lvgl9-c";
  };
}

/**
 * Compile a pure root component. The component is evaluated twice so a state,
 * time or random-dependent root fails before its artifacts can be consumed.
 */
export function compileProject(config: CompileConfig): BuildArtifacts {
  const projectName = config.projectName ?? "lume-project";
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
    format: "lume-build-artifacts-v0" as const,
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
