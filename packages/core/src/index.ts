export type ElementType = "Screen" | "View" | "Text" | "Button" | "Fragment";

export type Child = UiNode | readonly Child[] | null | undefined | false;

export interface UiElement {
  readonly kind: "element";
  readonly type: ElementType;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly UiNode[];
}

export type UiNode = UiElement;

export type LumeComponent<Props extends object = Record<string, unknown>> = (
  props: Props,
) => UiNode;

export interface ScreenProps {
  readonly children?: Child;
}

export interface ViewProps {
  readonly children?: Child;
}

export interface TextProps {
  readonly text: string | number;
}

export interface ButtonProps {
  readonly label: string;
  readonly action: string;
}

export interface FragmentProps {
  readonly children?: Child;
}

export function Screen(props: ScreenProps): UiNode {
  return element("Screen", {}, [props.children]);
}

export function View(props: ViewProps): UiNode {
  return element("View", {}, [props.children]);
}

export function Text(props: TextProps): UiNode {
  return element("Text", { text: props.text });
}

export function Button(props: ButtonProps): UiNode {
  return element("Button", { label: props.label, action: props.action });
}

export function element(
  type: ElementType,
  props: Readonly<Record<string, unknown>>,
  children: readonly Child[] = [],
): UiElement {
  return {
    kind: "element",
    type,
    props,
    children: normalizeChildren(children),
  };
}

export function normalizeChildren(children: readonly Child[]): readonly UiNode[] {
  const normalized: UiNode[] = [];
  for (const child of children) {
    if (Array.isArray(child)) {
      normalized.push(...normalizeChildren(child));
      continue;
    }
    if (isUiNode(child)) normalized.push(child);
  }
  return normalized;
}

function isUiNode(value: unknown): value is UiNode {
  return typeof value === "object" && value !== null && "kind" in value;
}
