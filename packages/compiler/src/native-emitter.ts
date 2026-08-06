import {
  exprStates,
  type BinaryOp,
  type CompareOp,
  type NativeCondition,
  type NativeExpr,
  type NativeNode,
  type NativeProgram,
} from "./native-program.js";

/**
 * Compiler-private native emitter. The only caller is compileProject, and the
 * typed program it receives is built by the source compiler. Keeping this seam
 * private prevents consumers from forging a native IR object at package APIs.
 *
 * State changes are separated from rendering: each live label owns a
 * `tsx_render_*` function and each conditional owns a `tsx_visibility_*`
 * function. A per-state `tsx_update_*` calls exactly the render/visibility
 * functions whose expression reads that state, so a handler mutates one slot
 * and repaints only what depends on it. The object tree is still fixed: both
 * branches of every conditional are created once and toggled by a hidden flag.
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
  }
  for (const binding of program.bindings) {
    lines.push(`static char ${bindingBuffer(binding.id)}[12];`);
    lines.push(`static lv_obj_t *${bindingVariable(binding.id)} = NULL;`);
  }
  for (const condition of program.conditions) {
    lines.push(`static lv_obj_t *${condTrue(condition.id)} = NULL;`);
    if (condition.hasAlternate) lines.push(`static lv_obj_t *${condFalse(condition.id)} = NULL;`);
  }
  if (program.states.length > 0 || program.bindings.length > 0 || program.conditions.length > 0) {
    lines.push("");
  }

  const used = collectUsedHelpers(program);
  for (const spec of Object.values(BINARY_OPS)) {
    if (!used.has(spec.name)) continue;
    lines.push(...(spec.guarded ? guardedDivHelper(spec.name, spec.operator, spec.overflow ?? "0") : saturatingHelper(spec.name, spec.operator)), "");
  }

  for (const binding of program.bindings) {
    lines.push(
      `static void ${renderFunction(binding.id)}(void)`,
      "{",
      `    (void)snprintf(${bindingBuffer(binding.id)}, sizeof(${bindingBuffer(binding.id)}), "%ld", (long)(${emitExpr(binding.expr)}));`,
      `    lv_label_set_text_static(${bindingVariable(binding.id)}, ${bindingBuffer(binding.id)});`,
      "}",
      "",
    );
  }

  for (const condition of program.conditions) {
    lines.push(...visibilityFunction(condition), "");
  }

  // Precompute each expression's state set once, rather than re-walking every
  // binding/condition for every state in the nested loop below.
  const bindingDeps = program.bindings.map((binding) => ({ binding, states: exprStates(binding.expr) }));
  const conditionDeps = program.conditions.map((condition) => ({ condition, states: exprStates(condition.predicate) }));
  for (const state of program.states) {
    lines.push(`static void ${updateFunction(state.id)}(void)`, "{");
    for (const { binding, states } of bindingDeps) {
      if (states.has(state.id)) lines.push(`    ${renderFunction(binding.id)}();`);
    }
    for (const { condition, states } of conditionDeps) {
      if (states.has(state.id)) lines.push(`    ${visibilityName(condition.id)}();`);
    }
    lines.push("}", "");
  }

  for (const [actionId, action] of Object.entries(program.actions)) {
    lines.push(
      `static void ${handlerFunction(actionId)}(lv_event_t *event)`,
      "{",
      "    if (lv_event_get_code(event) != LV_EVENT_CLICKED) return;",
      `    ${stateVariable(action.stateId)} = ${emitExpr(action.expr)};`,
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

function collectUsedHelpers(program: NativeProgram): ReadonlySet<string> {
  const used = new Set<string>();
  const scan = (expr: NativeExpr): void => {
    switch (expr.kind) {
      case "literal":
      case "state":
        return;
      case "unary":
        used.add("subtract"); // negation lowers to saturating_subtract(0, x)
        scan(expr.operand);
        return;
      case "binary":
        used.add(binaryHelper(expr.op));
        scan(expr.left);
        scan(expr.right);
        return;
      case "compare":
        scan(expr.left);
        scan(expr.right);
        return;
    }
  };
  for (const binding of program.bindings) scan(binding.expr);
  for (const condition of program.conditions) scan(condition.predicate);
  for (const action of Object.values(program.actions)) scan(action.expr);
  return used;
}

/**
 * Single source of truth for the C shape of each binary operator. `overflow`
 * is the result for the one guarded case `INT32_MIN OP -1`: division genuinely
 * overflows and saturates to INT32_MAX, while `x % -1` is always 0.
 */
const BINARY_OPS: Record<BinaryOp, { readonly name: string; readonly operator: string; readonly guarded: boolean; readonly overflow?: string }> = {
  add: { name: "add", operator: "+", guarded: false },
  sub: { name: "subtract", operator: "-", guarded: false },
  mul: { name: "mul", operator: "*", guarded: false },
  div: { name: "div", operator: "/", guarded: true, overflow: "INT32_MAX" },
  mod: { name: "mod", operator: "%", guarded: true, overflow: "0" },
};

function binaryHelper(op: BinaryOp): string {
  return BINARY_OPS[op].name;
}

function emitExpr(expr: NativeExpr): string {
  switch (expr.kind) {
    case "literal":
      return formatInt32(expr.value);
    case "state":
      return stateVariable(expr.stateId);
    case "unary":
      return `tsx_lvgl_saturating_subtract(0, ${emitExpr(expr.operand)})`;
    case "binary":
      return `${binaryFunction(expr.op)}(${emitExpr(expr.left)}, ${emitExpr(expr.right)})`;
    case "compare":
      return `((${emitExpr(expr.left)}) ${compareOperator(expr.op)} (${emitExpr(expr.right)}) ? 1 : 0)`;
  }
}

function binaryFunction(op: BinaryOp): string {
  const spec = BINARY_OPS[op];
  return `tsx_lvgl_${spec.guarded ? "guarded" : "saturating"}_${spec.name}`;
}

function compareOperator(op: CompareOp): string {
  switch (op) {
    case "lt":
      return "<";
    case "le":
      return "<=";
    case "gt":
      return ">";
    case "ge":
      return ">=";
    case "eq":
      return "==";
    case "ne":
      return "!=";
  }
}

function saturatingHelper(name: string, operator: string): string[] {
  return [
    `static int32_t tsx_lvgl_saturating_${name}(int32_t current, int32_t delta)`,
    "{",
    `    const int64_t candidate = (int64_t)current ${operator} (int64_t)delta;`,
    "    if (candidate > INT32_MAX) return INT32_MAX;",
    "    if (candidate < INT32_MIN) return INT32_MIN;",
    "    return (int32_t)candidate;",
    "}",
  ];
}

function guardedDivHelper(name: string, operator: string, overflow: string): string[] {
  return [
    `static int32_t tsx_lvgl_guarded_${name}(int32_t current, int32_t divisor)`,
    "{",
    "    if (divisor == 0) return 0;",
    `    if (current == INT32_MIN && divisor == -1) return ${overflow};`,
    `    return current ${operator} divisor;`,
    "}",
  ];
}

function visibilityFunction(condition: NativeCondition): string[] {
  const lines = [
    `static void ${visibilityName(condition.id)}(void)`,
    "{",
    `    if (${emitExpr(condition.predicate)}) {`,
    `        lv_obj_remove_flag(${condTrue(condition.id)}, LV_OBJ_FLAG_HIDDEN);`,
  ];
  if (condition.hasAlternate) lines.push(`        lv_obj_add_flag(${condFalse(condition.id)}, LV_OBJ_FLAG_HIDDEN);`);
  lines.push("    } else {", `        lv_obj_add_flag(${condTrue(condition.id)}, LV_OBJ_FLAG_HIDDEN);`);
  if (condition.hasAlternate) lines.push(`        lv_obj_remove_flag(${condFalse(condition.id)}, LV_OBJ_FLAG_HIDDEN);`);
  lines.push("    }", "}");
  return lines;
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
    case "conditional":
      emitConditionalBranch(node.condId, "t", node.consequent, `${variable}_t`, parent, program, output);
      if (node.alternate !== undefined) {
        emitConditionalBranch(node.condId, "f", node.alternate, `${variable}_f`, parent, program, output);
      }
      return;
  }
}

function emitConditionalBranch(
  condId: string,
  side: "t" | "f",
  child: NativeNode,
  variable: string,
  parent: string,
  program: NativeProgram,
  output: string[],
): void {
  output.push(`lv_obj_t *${variable} = lv_obj_create(${parent});`);
  output.push(`lv_obj_remove_style_all(${variable});`);
  output.push(`lv_obj_set_size(${variable}, LV_SIZE_CONTENT, LV_SIZE_CONTENT);`);
  output.push(`lv_obj_set_flex_flow(${variable}, LV_FLEX_FLOW_COLUMN);`);
  output.push(`${side === "t" ? condTrue(condId) : condFalse(condId)} = ${variable};`);
  emitNativeNode(child, `${variable}_0`, variable, program, output);
}

function flexAlign(value: "start" | "center" | "end"): string {
  return `LV_FLEX_ALIGN_${value.toUpperCase()}`;
}

function stateVariable(id: string): string {
  return `tsx_state_${id}`;
}

function bindingBuffer(id: string): string {
  return `tsx_binding_${id}_text`;
}

function renderFunction(id: string): string {
  return `tsx_render_${id}`;
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

function visibilityName(id: string): string {
  return `tsx_visibility_${id}`;
}

function condTrue(id: string): string {
  return `tsx_cond_${id}_t`;
}

function condFalse(id: string): string {
  return `tsx_cond_${id}_f`;
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
