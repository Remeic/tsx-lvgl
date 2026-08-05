import type { UiElement, UiNode } from "@tsx-lvgl/core";

/** Emit validated semantic nodes as readable LVGL 9 C. */
export function emitLvgl(root: UiNode): string {
  validateNode(root, "root");

  const actions = collectActions(root);
  const body: string[] = [];
  emitNode(root, "root", "root", body);

  return [
    "#include \"lvgl.h\"",
    "",
    ...[...actions].flatMap((action) => [
      `static void tsx_lvgl_action_${action}(lv_event_t *event)`,
      "{",
      "    lv_obj_t *label = lv_event_get_user_data(event);",
      "    lv_label_set_text(label, \"Touched\");",
      "}",
      "",
    ]),
    "void tsx_lvgl_ui_create(void)",
    "{",
    "    lv_obj_t *root = lv_screen_active();",
    "    lv_obj_set_flex_flow(root, LV_FLEX_FLOW_COLUMN);",
    "    lv_obj_set_flex_align(root, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);",
    ...body.map((line) => `    ${line}`),
    "}",
    "",
  ].join("\n");
}

function validateNode(node: UiNode, path: string): asserts node is UiElement {
  if (!isRecord(node) || node.kind !== "element") {
    throw new Error(`Unsupported node at ${path}`);
  }
  if (!isElementType(node.type)) {
    throw new Error(`Unsupported node type at ${path}.type`);
  }
  if (!isRecord(node.props)) {
    throw new Error(`Invalid props at ${path}.props`);
  }
  if (!Array.isArray(node.children)) {
    throw new Error(`Invalid children at ${path}.children`);
  }
  validateWidgetShape(node, path);
  node.children.forEach((child, index) => validateNode(child, `${path}.children[${index}]`));
}

function validateWidgetShape(node: UiElement, path: string): void {
  switch (node.type) {
    case "Screen":
    case "View":
    case "Fragment":
      rejectUnexpectedProps(node.props, path);
      return;
    case "Text":
      requireProps(node.props, ["text"], path);
      asString(node.props.text, `${path}.text`);
      rejectChildren(node.children, path, node.type);
      return;
    case "Button":
      requireProps(node.props, ["label", "action"], path);
      asRequiredString(node.props.label, `${path}.label`);
      asIdentifier(node.props.action, `${path}.action`);
      rejectChildren(node.children, path, node.type);
      return;
  }
}

function requireProps(
  props: Readonly<Record<string, unknown>>,
  required: readonly string[],
  path: string,
): void {
  const allowed = new Set(required);
  const unexpected = Object.keys(props).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`Invalid props at ${path}.props.${unexpected}`);
  }
}

function rejectUnexpectedProps(props: Readonly<Record<string, unknown>>, path: string): void {
  const unexpected = Object.keys(props)[0];
  if (unexpected) {
    throw new Error(`Invalid props at ${path}.props.${unexpected}`);
  }
}

function rejectChildren(children: readonly UiNode[], path: string, type: string): void {
  if (children.length > 0) {
    throw new Error(`Invalid children at ${path}.children: ${type} does not accept children`);
  }
}

function emitNode(node: UiElement, variable: string, parent: string, output: string[]): void {
  switch (node.type) {
    case "Screen":
    case "Fragment":
      node.children.forEach((child, index) => emitNode(child, `${variable}_${index}`, parent, output));
      return;
    case "View":
      output.push(`lv_obj_t *${variable} = lv_obj_create(${parent});`);
      output.push(`lv_obj_set_flex_flow(${variable}, LV_FLEX_FLOW_COLUMN);`);
      output.push(`lv_obj_set_flex_align(${variable}, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);`);
      node.children.forEach((child, index) => emitNode(child, `${variable}_${index}`, variable, output));
      return;
    case "Text": {
      const text = String(node.props.text);
      output.push(`lv_obj_t *${variable} = lv_label_create(${parent});`);
      output.push(`lv_label_set_text(${variable}, ${quoteC(text)});`);
      return;
    }
    case "Button": {
      const label = String(node.props.label);
      const action = String(node.props.action);
      output.push(`lv_obj_t *${variable} = lv_button_create(${parent});`);
      output.push(`lv_obj_t *${variable}_label = lv_label_create(${variable});`);
      output.push(`lv_label_set_text(${variable}_label, ${quoteC(label)});`);
      output.push(`lv_obj_center(${variable}_label);`);
      output.push(`lv_obj_add_event_cb(${variable}, tsx_lvgl_action_${action}, LV_EVENT_CLICKED, ${variable}_label);`);
      return;
    }
  }
}

function collectActions(node: UiNode, actions = new Set<string>()): Set<string> {
  if (node.type === "Button") {
    actions.add(String(node.props.action));
  }
  node.children.forEach((child) => collectActions(child, actions));
  return actions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isElementType(value: unknown): value is UiElement["type"] {
  return value === "Screen" || value === "View" || value === "Text" || value === "Button" || value === "Fragment";
}

function asString(value: unknown, path: string): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new Error(`Expected string or number at ${path}`);
}

function asRequiredString(value: unknown, path: string): string {
  if (typeof value === "string") return value;
  throw new Error(`Expected string at ${path}`);
}

function asIdentifier(value: unknown, path: string): string {
  const identifier = asRequiredString(value, path);
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
      case "?":
        // Escape question marks so C11 trigraph translation cannot rewrite
        // an author-controlled literal before the string is parsed.
        quoted += "\\?";
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
