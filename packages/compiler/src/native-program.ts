/**
 * Compiler-owned semantic representation. This module is intentionally not
 * exported from the package root; the public compiler API returns C artifacts.
 */

/** Binary arithmetic operators. add/sub/mul saturate; div/mod are guarded. */
export type BinaryOp = "add" | "sub" | "mul" | "div" | "mod";

/** Integer comparison operators; each lowers to a 0/1 int32 value. */
export type CompareOp = "lt" | "le" | "gt" | "ge" | "eq" | "ne";

/**
 * A bounded signed-int32 expression tree. Every arithmetic node saturates to
 * the int32 range; div/mod additionally guard division by zero and the
 * INT32_MIN / -1 overflow. There is no float, string, call, or heap value here:
 * the whole tree lowers to a single C expression with no allocation.
 */
export type NativeExpr =
  | { readonly kind: "literal"; readonly value: number }
  | { readonly kind: "state"; readonly stateId: string }
  | { readonly kind: "unary"; readonly op: "neg"; readonly operand: NativeExpr }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: NativeExpr; readonly right: NativeExpr }
  | { readonly kind: "compare"; readonly op: CompareOp; readonly left: NativeExpr; readonly right: NativeExpr };

export type NativeText =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "binding"; readonly bindingId: string };

export type NativeNode =
  | { readonly kind: "screen"; readonly children: readonly NativeNode[] }
  | { readonly kind: "fragment"; readonly children: readonly NativeNode[] }
  | {
      readonly kind: "view";
      readonly direction: "row" | "column";
      readonly align: "start" | "center" | "end";
      readonly gap: number;
      readonly children: readonly NativeNode[];
    }
  | { readonly kind: "text"; readonly value: NativeText }
  | { readonly kind: "button"; readonly label: string; readonly actionId: string }
  | {
      readonly kind: "conditional";
      readonly condId: string;
      readonly consequent: NativeNode;
      readonly alternate: NativeNode | undefined;
    };

/** A handler assigns one evaluated expression into one state slot. */
export type NativeAction = { readonly kind: "assign"; readonly stateId: string; readonly expr: NativeExpr };

/** A label whose text is a live int32 expression, recomputed on dependency change. */
export interface NativeBinding {
  readonly id: string;
  readonly expr: NativeExpr;
}

/** A conditional subtree whose branch visibility follows an int32 predicate. */
export interface NativeCondition {
  readonly id: string;
  readonly predicate: NativeExpr;
  readonly hasAlternate: boolean;
}

export interface NativeState {
  readonly id: string;
  readonly initial: number;
}

export interface NativeProgram {
  readonly format: "tsx-lvgl-native-program-v0";
  readonly root: NativeNode;
  readonly states: readonly NativeState[];
  readonly bindings: readonly NativeBinding[];
  readonly conditions: readonly NativeCondition[];
  readonly actions: Readonly<Record<string, NativeAction>>;
  readonly testButtonActionId?: string;
}

/** Every state id an expression reads, for render/visibility dependency wiring. */
export function exprStates(expr: NativeExpr): ReadonlySet<string> {
  const ids = new Set<string>();
  const walk = (node: NativeExpr): void => {
    switch (node.kind) {
      case "literal":
        return;
      case "state":
        ids.add(node.stateId);
        return;
      case "unary":
        walk(node.operand);
        return;
      case "binary":
      case "compare":
        walk(node.left);
        walk(node.right);
        return;
    }
  };
  walk(expr);
  return ids;
}
