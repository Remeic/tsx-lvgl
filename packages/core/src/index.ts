export type ElementType = "Screen" | "View" | "Text" | "Button" | "Fragment";

export type Child = UiNode | readonly Child[] | null | undefined | false;

export interface UiElement {
  readonly kind: "element";
  readonly type: ElementType;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly UiNode[];
}

export type UiNode = UiElement;

export type TsxLvglComponent<Props extends object = Record<string, unknown>> = (
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
  // Stryker disable next-line ArrayDeclaration: normalizeChildren removes the non-node sentinel.
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
  return normalizeChildrenAt(children, "children");
}

function normalizeChildrenAt(children: readonly Child[], path: string): readonly UiNode[] {
  const normalized: UiNode[] = [];
  for (const [index, child] of children.entries()) {
    if (Array.isArray(child)) {
      normalized.push(...normalizeChildrenAt(child, `${path}[${index}]`));
      continue;
    }
    if (isUiNode(child)) normalized.push(child);
    else if (isRecord(child)) throw new Error(`Invalid child at ${path}[${index}]`);
  }
  return normalized;
}

function isUiNode(value: unknown): value is UiNode {
  if (!isRecord(value) || value.kind !== "element" || !isElementType(value.type)) return false;
  return isRecord(value.props) && Array.isArray(value.children);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isElementType(value: unknown): value is ElementType {
  return value === "Screen" || value === "View" || value === "Text" || value === "Button" || value === "Fragment";
}
