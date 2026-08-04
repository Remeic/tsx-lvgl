import type { UiElement, UiNode } from "@lume/core";

/** Emit validated semantic nodes as readable LVGL 9 C. */
export function emitLvgl(root: UiNode): string {
  validateNode(root, "root");

  const body: string[] = [];
  emitNode(root, "root", "root", body);

  return [
    "#include \"lvgl.h\"",
    "",
    "void lume_ui_create(void)",
    "{",
    "    lv_obj_t *root = lv_screen_active();",
    ...body.map((line) => `    ${line}`),
    "}",
    "",
  ].join("\n");
}

function validateNode(node: UiNode, path: string): asserts node is UiElement {
  if (!isRecord(node) || node.kind !== "element") {
    throw new Error(`Unsupported node at ${path}`);
  }
  if (!isRecord(node.props)) {
    throw new Error(`Invalid props at ${path}.props`);
  }
  if (!Array.isArray(node.children)) {
    throw new Error(`Invalid children at ${path}.children`);
  }
  node.children.forEach((child, index) => validateNode(child, `${path}.children[${index}]`));
}

function emitNode(node: UiElement, variable: string, parent: string, output: string[]): void {
  switch (node.type) {
    case "Screen":
    case "Fragment":
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
      const action = asIdentifier(node.props.action, `${variable}.action`);
      output.push(`lv_obj_t *${variable} = lv_button_create(${parent});`);
      output.push(`lv_obj_t *${variable}_label = lv_label_create(${variable});`);
      output.push(`lv_label_set_text(${variable}_label, ${quoteC(label)});`);
      output.push(`/* Lume action: ${action} */`);
      return;
    }
  }
  throw new Error(`Unsupported node type at ${variable}.type`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, path: string): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new Error(`Expected string or number at ${path}`);
}

function asIdentifier(value: unknown, path: string): string {
  const identifier = asString(value, path);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Expected C identifier at ${path}`);
  }
  return identifier;
}

function quoteC(value: string): string {
  let quoted = '"';
  for (const character of value) {
    switch (character) {
      case "\\":
        quoted += "\\\\";
        break;
      case '"':
        quoted += '\\"';
        break;
      case "\b":
        quoted += "\\b";
        break;
      case "\f":
        quoted += "\\f";
        break;
      case "\n":
        quoted += "\\n";
        break;
      case "\r":
        quoted += "\\r";
        break;
      case "\t":
        quoted += "\\t";
        break;
      case "\v":
        quoted += "\\v";
        break;
      default: {
        const code = character.charCodeAt(0);
        quoted += code < 0x20 || code === 0x7f
          ? `\\${code.toString(8).padStart(3, "0")}`
          : character;
      }
    }
  }
  return `${quoted}"`;
}
