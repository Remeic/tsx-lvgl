import {
  Button,
  Fragment,
  Screen,
  Text,
  View,
  type ButtonProps,
  type FragmentProps,
  type ReactChild,
  type ReactElement,
  type ScreenProps,
  type TextProps,
  type ViewProps,
} from "./index.js";
import { normalizeChildren, type Child as CoreChild, type ElementType } from "@tsx-lvgl/core";

export { Fragment };

export namespace JSX {
  export type Element = ReactElement;

  export interface ElementChildrenAttribute {
    children: {};
  }

  export interface IntrinsicElements {
    Screen: ScreenProps;
    View: ViewProps;
    Text: TextProps;
    Button: ButtonProps;
  }
}

type IntrinsicName = keyof JSX.IntrinsicElements;
type StaticComponent = (props?: Readonly<Record<string, unknown>>) => ReactElement;
type ReactJsxType = IntrinsicName | StaticComponent;

export function jsx(type: ReactJsxType, props: Readonly<Record<string, unknown>> | null): ReactElement {
  const input = props ?? {};
  const { children, ...elementProps } = input;
  const childList: ReactChild[] = Array.isArray(children) ? [...children] as ReactChild[] : [children as ReactChild];

  if (typeof type === "function") {
    if (type === Fragment) return Fragment({ children: childList });
    if (type === Screen) return Screen({ children: childList });
    if (type === View) return View({ ...elementProps, children: childList } as ViewProps);
    if (type === Text) {
      const child = childList[0];
      return Text({ ...elementProps, ...(child === undefined ? {} : { children: child }) } as TextProps);
    }
    if (type === Button) {
      const child = childList[0];
      return Button({ ...elementProps, ...(child === undefined ? {} : { children: child }) } as ButtonProps);
    }
    if (hasMeaningfulChildren(childList)) {
      throw new Error("component children are unsupported in this MVP; compose zero-argument components");
    }
    // Props are resolved by the compiler; the host runtime forwards them so
    // component authoring type-checks, but calling this on-device is unsupported.
    return type(elementProps);
  }

  // TypeScript normally lowers intrinsic tags through the branches above. Keep
  // this fallback for direct jsx-runtime consumers without exposing core nodes.
  return asReactElement(elementForIntrinsic(type, elementProps, childList));
}

function elementForIntrinsic(
  type: IntrinsicName,
  props: Readonly<Record<string, unknown>>,
  children: readonly ReactChild[],
) {
  const coreType = type as ElementType;
  return {
    kind: "element" as const,
    type: coreType,
    props,
    children: normalizeChildren(children as unknown as readonly CoreChild[]),
  };
}

function asReactElement(value: unknown): ReactElement {
  return value as ReactElement;
}

function hasMeaningfulChildren(children: readonly unknown[]): boolean {
  return children.some((child) => {
    if (Array.isArray(child)) return hasMeaningfulChildren(child);
    if (typeof child === "string") return child.trim().length > 0;
    return child !== null && child !== undefined && child !== false;
  });
}

export const jsxs = jsx;
