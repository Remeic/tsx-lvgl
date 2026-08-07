export type Key = string | number | null;

declare const fragmentType: unique symbol;
export const Fragment: typeof fragmentType = Symbol.for("@tsx-lvgl/core/Fragment") as typeof fragmentType;

/**
 * The whole widget vocabulary, declared once. `ElementType`, the JSX intrinsic
 * table, the exported tag constants and the host adapter's switch all derive
 * from this pair, so adding a widget is one array entry plus one props entry.
 */
export const elementTypes = ["Screen", "View", "Text", "Button"] as const;

export type ElementType = (typeof elementTypes)[number];

/** `extends Record<ElementType, object>` fails the build if a tag has no props. */
export interface WidgetProps extends Record<ElementType, object> {
  readonly Screen: { readonly children?: VNodeChild };
  readonly View: { readonly children?: VNodeChild };
  readonly Text: { readonly text: string | number };
  readonly Button: { readonly label: string; readonly onClick?: () => void };
}

/**
 * Tag constants are the string literals themselves: `<Text text="x" />` type
 * checks against `WidgetProps` and creates an element VNode directly, with no
 * wrapper component fiber on the device.
 */
export const Screen = "Screen";
export const View = "View";
export const Text = "Text";
export const Button = "Button";

export type Component<Props extends object = Record<string, unknown>> = (
  props: Props & { readonly children: readonly VNode[] },
) => VNodeChild;

export type VNodeType = ElementType | Component | typeof Fragment;
export type VNodeChild = VNode | readonly VNodeChild[] | string | number | boolean | null | undefined;

interface VNodeIdentity {
  readonly key: Key;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly VNode[];
}

export interface ElementVNode extends VNodeIdentity {
  readonly kind: "element";
  readonly type: ElementType;
}

export interface ComponentVNode extends VNodeIdentity {
  readonly kind: "component";
  readonly type: Component;
}

export interface FragmentVNode extends VNodeIdentity {
  readonly kind: "fragment";
  readonly type: typeof Fragment;
}

/**
 * Immutable and lazy: a component VNode names its function, it never holds the
 * function's output. `kind` discriminates `type`, so consumers narrow instead
 * of casting.
 */
export type VNode = ElementVNode | ComponentVNode | FragmentVNode;

const elementTypeNames: ReadonlySet<string> = new Set(elementTypes);
const emptyChildren: readonly VNode[] = Object.freeze([]);
const emptyProps: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Freezes `props` in place rather than copying it: VNode inputs are owned by
 * the tree from this call on, and a copy per node per render is the single
 * largest avoidable allocation on the device.
 */
export function createVNode(
  type: VNodeType,
  props: Readonly<Record<string, unknown>> | null = emptyProps,
  children: readonly VNodeChild[] = emptyChildren,
  key: Key = null,
): VNode {
  const kind = type === Fragment
    ? "fragment"
    : typeof type === "function"
      ? "component"
      : "element";
  return Object.freeze({
    kind,
    type,
    key,
    props: Object.freeze(props ?? emptyProps),
    children: normalizeChildren(children),
  }) as VNode;
}

export function normalizeChildren(children: readonly VNodeChild[]): readonly VNode[] {
  const normalized: VNode[] = [];
  for (const child of children) visitChild(child, normalized);
  return normalized.length === 0 ? emptyChildren : Object.freeze(normalized);
}

function visitChild(value: VNodeChild, out: VNode[]): void {
  if (Array.isArray(value)) {
    for (const child of value as readonly VNodeChild[]) visitChild(child, out);
    return;
  }
  if (value === null || value === undefined || typeof value === "boolean") return;
  if (typeof value === "string" || typeof value === "number") {
    out.push(createVNode(Text, { text: value }));
    return;
  }
  if (!isVNode(value)) {
    throw new Error("Invalid child: expected a VNode, string, number, or empty value");
  }
  out.push(value);
}

/**
 * Structural guard for untrusted trees: a hot-reloaded bundle can hand the
 * runtime anything, so element names are checked against the vocabulary.
 */
export function isVNode(value: unknown): value is VNode {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<VNode>;
  const type = candidate.type;
  const validKind = (
    (candidate.kind === "element" && elementTypeNames.has(type as string)) ||
    (candidate.kind === "component" && typeof type === "function") ||
    (candidate.kind === "fragment" && type === Fragment)
  );
  const validKey = candidate.key === null || typeof candidate.key === "string" || typeof candidate.key === "number";
  return (
    validKind &&
    validKey &&
    typeof candidate.props === "object" &&
    candidate.props !== null &&
    Array.isArray(candidate.children)
  );
}
