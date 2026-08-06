/**
 * Compiler-owned semantic representation. This module is intentionally not
 * exported from the package root; the public compiler API returns C artifacts.
 */
export type NativeText =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "state"; readonly stateId: string; readonly bindingId: string };

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
  | { readonly kind: "button"; readonly label: string; readonly actionId: string };

export type NativeAction =
  | { readonly kind: "set"; readonly stateId: string; readonly value: number }
  | { readonly kind: "add"; readonly stateId: string; readonly value: number }
  | { readonly kind: "subtract"; readonly stateId: string; readonly value: number };

export interface NativeState {
  readonly id: string;
  readonly initial: number;
  readonly bindingIds: readonly string[];
}

export interface NativeProgram {
  readonly format: "tsx-lvgl-native-program-v0";
  readonly root: NativeNode;
  readonly states: readonly NativeState[];
  readonly actions: Readonly<Record<string, NativeAction>>;
  readonly testButtonActionId?: string;
}
