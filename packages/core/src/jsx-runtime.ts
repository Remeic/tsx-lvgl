import {
  element,
  normalizeChildren,
  type Child,
  type ElementType,
  type FragmentProps,
  type TsxLvglComponent,
  type UiNode,
} from "./index.js";

export namespace JSX {
  export type Element = UiNode;

  export interface ElementChildrenAttribute {
    children: {};
  }

  export interface IntrinsicElements {
    Screen: { children?: Child };
    View: { children?: Child };
    Text: { text: string | number };
    Button: { label: string; action: string };
  }
}

export function Fragment(props: FragmentProps): UiNode {
  return element("Fragment", {}, [props.children]);
}

export function jsx(
  type: ElementType | TsxLvglComponent,
  props: Readonly<Record<string, unknown>> | null,
): UiNode {
  const input = props ?? {};
  const { children, ...elementProps } = input;
  const childList: Child[] = Array.isArray(children) ? [...children] : [children as Child];

  if (typeof type === "function") {
    return type({ ...elementProps, children: normalizeChildren(childList) });
  }

  return element(type, elementProps, childList);
}

export const jsxs = jsx;
