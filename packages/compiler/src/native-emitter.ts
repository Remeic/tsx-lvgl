import type { NativeAction, NativeNode, NativeProgram } from "./native-program.js";

/**
 * Compiler-private native emitter. The only caller is compileProject, and the
 * typed program it receives is built by the source compiler. Keeping this seam
 * private prevents consumers from forging a native IR object at package APIs.
 */
export function emitNativeProgram(program: NativeProgram): string {
  const lines: string[] = [
    '#include "lvgl.h"',
    "#include <stdint.h>",
    "#include <stdio.h>",
    "",
  ];

  for (const state of program.states) {
    lines.push(`static int32_t ${stateVariable(state.id)} = ${formatInt32(state.initial)};`);
    lines.push(`static char ${stateBuffer(state.id)}[12];`);
    for (const bindingId of state.bindingIds) {
      lines.push(`static lv_obj_t *${bindingVariable(bindingId)} = NULL;`);
    }
  }
  if (program.states.length > 0) lines.push("");

  const actionKinds = new Set(Object.values(program.actions).map((action) => action.kind));
  if (actionKinds.has("add")) {
    lines.push(
      "static int32_t tsx_lvgl_saturating_add(int32_t current, int32_t delta)",
      "{",
      "    const int64_t candidate = (int64_t)current + (int64_t)delta;",
      "    if (candidate > INT32_MAX) return INT32_MAX;",
      "    if (candidate < INT32_MIN) return INT32_MIN;",
      "    return (int32_t)candidate;",
      "}",
      "",
    );
  }
  if (actionKinds.has("subtract")) {
    lines.push(
      "static int32_t tsx_lvgl_saturating_subtract(int32_t current, int32_t delta)",
      "{",
      "    const int64_t candidate = (int64_t)current - (int64_t)delta;",
      "    if (candidate > INT32_MAX) return INT32_MAX;",
      "    if (candidate < INT32_MIN) return INT32_MIN;",
      "    return (int32_t)candidate;",
      "}",
      "",
    );
  }

  for (const state of program.states) {
    lines.push(
      `static void ${updateFunction(state.id)}(void)`,
      "{",
      `    (void)snprintf(${stateBuffer(state.id)}, sizeof(${stateBuffer(state.id)}), "%ld", (long)${stateVariable(state.id)});`,
    );
    for (const bindingId of state.bindingIds) {
      lines.push(`    lv_label_set_text_static(${bindingVariable(bindingId)}, ${stateBuffer(state.id)});`);
    }
    lines.push("}", "");
  }

  for (const [actionId, action] of Object.entries(program.actions)) {
    lines.push(
      `static void ${handlerFunction(actionId)}(lv_event_t *event)`,
      "{",
      "    if (lv_event_get_code(event) != LV_EVENT_CLICKED) return;",
      ...emitAction(action),
      `    ${updateFunction(action.stateId)}();`,
      "}",
      "",
    );
  }

  lines.push(
    "#ifdef TSX_LVGL_TEST_HOOKS",
    "static lv_obj_t *tsx_lvgl_test_button = NULL;",
    "#endif",
    "",
    "void tsx_lvgl_ui_create(void)",
    "{",
    "    lv_obj_t *root = lv_screen_active();",
    "    lv_obj_set_flex_flow(root, LV_FLEX_FLOW_COLUMN);",
    "    lv_obj_set_style_pad_all(root, 12, 0);",
  );

  const body: string[] = [];
  emitNativeNode(program.root, "root", "root", program, body);
  lines.push(...body.map((line) => `    ${line}`));
  for (const state of program.states) lines.push(`    ${updateFunction(state.id)}();`);
  lines.push("}", "");

  if (program.testButtonActionId !== undefined) {
    lines.push(
      "#ifdef TSX_LVGL_TEST_HOOKS",
      "void tsx_lvgl_ui_test_click(void)",
      "{",
      "    if (tsx_lvgl_test_button != NULL) lv_obj_send_event(tsx_lvgl_test_button, LV_EVENT_CLICKED, NULL);",
      "}",
      "#endif",
      "",
    );
  }
  lines.push("#ifdef TSX_LVGL_TEST_HOOKS");
  for (const state of program.states) {
    lines.push(
      `int32_t tsx_lvgl_ui_state_${state.id}(void)`,
      "{",
      `    return ${stateVariable(state.id)};`,
      "}",
      "",
    );
  }
  lines.push("#endif", "");

  return `${lines.join("\n")}\n`;
}

function emitAction(action: NativeAction): string[] {
  const variable = stateVariable(action.stateId);
  const value = formatInt32(action.value);
  switch (action.kind) {
    case "set":
      return [`    ${variable} = ${value};`];
    case "add":
      return [`    ${variable} = tsx_lvgl_saturating_add(${variable}, ${value});`];
    case "subtract":
      return [`    ${variable} = tsx_lvgl_saturating_subtract(${variable}, ${value});`];
  }
}

function emitNativeNode(
  node: NativeNode,
  variable: string,
  parent: string,
  program: NativeProgram,
  output: string[],
): void {
  switch (node.kind) {
    case "screen":
    case "fragment":
      node.children.forEach((child, index) => emitNativeNode(child, `${variable}_${index}`, parent, program, output));
      return;
    case "view":
      output.push(`lv_obj_t *${variable} = lv_obj_create(${parent});`);
      output.push(`lv_obj_set_flex_flow(${variable}, LV_FLEX_FLOW_${node.direction.toUpperCase()});`);
      output.push(`lv_obj_set_flex_align(${variable}, ${flexAlign(node.align)}, ${flexAlign(node.align)}, ${flexAlign(node.align)});`);
      output.push(`lv_obj_set_style_pad_row(${variable}, ${node.gap}, 0);`);
      output.push(`lv_obj_set_style_pad_column(${variable}, ${node.gap}, 0);`);
      node.children.forEach((child, index) => emitNativeNode(child, `${variable}_${index}`, variable, program, output));
      return;
    case "text":
      output.push(`lv_obj_t *${variable} = lv_label_create(${parent});`);
      if (node.value.kind === "literal") {
        output.push(`lv_label_set_text(${variable}, ${quoteC(node.value.value)});`);
      } else {
        output.push(`${bindingVariable(node.value.bindingId)} = ${variable};`);
      }
      return;
    case "button":
      output.push(`lv_obj_t *${variable} = lv_button_create(${parent});`);
      output.push(`lv_obj_t *${variable}_label = lv_label_create(${variable});`);
      output.push(`lv_label_set_text(${variable}_label, ${quoteC(node.label)});`);
      output.push(`lv_obj_add_event_cb(${variable}, ${handlerFunction(node.actionId)}, LV_EVENT_CLICKED, NULL);`);
      if (program.testButtonActionId === node.actionId) {
        output.push("#ifdef TSX_LVGL_TEST_HOOKS");
        output.push(`tsx_lvgl_test_button = ${variable};`);
        output.push("#endif");
      }
      return;
  }
}

function flexAlign(value: "start" | "center" | "end"): string {
  return `LV_FLEX_ALIGN_${value.toUpperCase()}`;
}

function stateVariable(id: string): string {
  return `tsx_state_${id}`;
}

function stateBuffer(id: string): string {
  return `tsx_state_${id}_text`;
}

function updateFunction(id: string): string {
  return `tsx_update_${id}`;
}

function handlerFunction(id: string): string {
  return `tsx_handler_${id}`;
}

function bindingVariable(id: string): string {
  return `tsx_binding_${id}`;
}

function formatInt32(value: number): string {
  return value === -2147483648 ? "(-2147483647 - 1)" : String(value);
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
