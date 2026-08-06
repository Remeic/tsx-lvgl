import {
  element,
  normalizeChildren,
  type Child as CoreChild,
  type UiNode as CoreNode,
} from "@tsx-lvgl/core";

declare const reactElementBrand: unique symbol;

/** An opaque compatibility element; native/core node details are not public here. */
export interface ReactElement {
  readonly [reactElementBrand]: true;
}

export type ReactChild = ReactElement | readonly ReactChild[] | null | undefined | false;

export interface ScreenProps {
  readonly children?: ReactChild;
}

export type FlexDirection = "row" | "column";
export type FlexAlign = "start" | "center" | "end";

export interface ViewProps {
  readonly children?: ReactChild;
  readonly direction?: FlexDirection;
  readonly align?: FlexAlign;
  readonly gap?: number;
}

export type TextProps =
  | { readonly text: string | number; readonly children?: never }
  | { readonly text?: never; readonly children: string | number };

export type ButtonProps =
  | { readonly label: string; readonly children?: never; readonly onClick: () => void }
  | { readonly label?: never; readonly children: string; readonly onClick: () => void };

export interface FragmentProps {
  readonly children?: ReactChild;
}

/** A compiler-only integer state setter. It has no device runtime implementation. */
export type StateSetter = (value: number | ((previous: number) => number)) => void;

/**
 * React-shaped authoring declaration for the bounded compiler subset.
 * Source entries are analyzed at build time; calling this function at runtime
 * is intentionally unsupported because the device has no JavaScript runtime.
 */
export function useState(initialState: number): readonly [number, StateSetter] {
  throw new Error("@tsx-lvgl/react useState is compiler-only; compile the TSX entry file first");
}

export function Fragment(props: FragmentProps): ReactElement {
  return asReactElement(element("Fragment", {}, [normalizeReactNodes(props.children)]));
}

export function Screen(props: ScreenProps): ReactElement {
  return asReactElement(element("Screen", {}, [normalizeReactNodes(props.children)]));
}

export function View(props: ViewProps): ReactElement {
  const viewProps: Record<string, unknown> = {};
  if (props.direction !== undefined) viewProps.direction = props.direction;
  if (props.align !== undefined) viewProps.align = props.align;
  if (props.gap !== undefined) viewProps.gap = props.gap;
  return asReactElement(element("View", viewProps, [normalizeReactNodes(props.children)]));
}

export function Text(props: TextProps): ReactElement {
  const text = "text" in props ? props.text : props.children;
  if (text === undefined) throw new Error("Text requires text or a direct primitive child");
  return asReactElement(element("Text", { text }));
}

export function Button(props: ButtonProps): ReactElement {
  const label = "label" in props ? props.label : props.children;
  if (label === undefined) throw new Error("Button requires a label or a direct string child");
  return asReactElement(element("Button", { label, onClick: props.onClick }));
}

function normalizeReactNodes(value: ReactChild | undefined): CoreChild {
  if (Array.isArray(value)) return normalizeChildren(value as unknown as readonly CoreChild[]);
  if (value === null || value === undefined || value === false || isCoreNode(value)) {
    return value as unknown as CoreChild;
  }
  throw new Error("Screen, View, and Fragment accept UI elements as children");
}

function isCoreNode(value: unknown): value is CoreNode {
  return typeof value === "object" && value !== null && (value as CoreNode).kind === "element";
}

function asReactElement(node: CoreNode): ReactElement {
  return node as unknown as ReactElement;
}
