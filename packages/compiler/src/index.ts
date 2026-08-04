import type { LumeComponent, UiElement, UiNode } from "@lume/core";

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

export function compileProject(config: CompileConfig): BuildArtifacts {
  const projectName = config.projectName ?? "lume-project";
  const root = config.root({});
  validateNode(root, "root");

  const body: string[] = [];
  emitNode(root, "root", "root", body);

  const uiC = [
    "#include \"lvgl.h\"",
    "",
    "void lume_ui_create(void)",
    "{",
    "    lv_obj_t *root = lv_screen_active();",
    ...body.map((line) => `    ${line}`),
    "}",
    "",
  ].join("\n");

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

function validateNode(node: UiNode, path: string): asserts node is UiElement {
  if (node.kind !== "element") {
    throw new Error(`Unsupported node at ${path}`);
  }
  node.children.forEach((child, index) => validateNode(child, `${path}.children[${index}]`));
}

function emitNode(node: UiElement, variable: string, parent: string, output: string[]): void {
  switch (node.type) {
    case "Screen":
      node.children.forEach((child, index) => emitNode(child, `${variable}_${index}`, parent, output));
      return;
    case "View":
      output.push(`lv_obj_t *${variable} = lv_obj_create(${parent});`);
      node.children.forEach((child, index) => emitNode(child, `${variable}_${index}`, variable, output));
      return;
    case "Text": {
      const text = asString(node.props.text, `${variable}.text`);
      output.push(`lv_obj_t *${variable} = lv_label_create(${parent});`);
      output.push(`lv_label_set_text(${variable}, ${quoteC(text)});`);
      return;
    }
    case "Button": {
      const label = asString(node.props.label, `${variable}.label`);
      const action = asString(node.props.action, `${variable}.action`);
      output.push(`lv_obj_t *${variable} = lv_button_create(${parent});`);
      output.push(`lv_obj_t *${variable}_label = lv_label_create(${variable});`);
      output.push(`lv_label_set_text(${variable}_label, ${quoteC(label)});`);
      output.push(`/* Lume action: ${action} */`);
      return;
    }
  }
}

function asString(value: unknown, path: string): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new Error(`Expected string or number at ${path}`);
}

function quoteC(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}
