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

/** S1 box style keys. Named colors resolve to fixed RGB ints; `transparent` means "absent". */
export type StyleColor = `#${string}` | "red" | "green" | "blue" | "black" | "white" | "gray" | "yellow" | "cyan" | "magenta" | "transparent";

/** S2 size key: px, a `"N%"` percent string, or `"auto"` (content-sized). */
export type StyleDim = number | `${number}%` | "auto";

export interface ViewStyle {
  readonly backgroundColor?: StyleColor;
  readonly borderColor?: StyleColor;
  readonly borderWidth?: number;
  readonly borderRadius?: number;
  readonly padding?: number;
  readonly paddingTop?: number;
  readonly paddingRight?: number;
  readonly paddingBottom?: number;
  readonly paddingLeft?: number;
  readonly paddingHorizontal?: number;
  readonly paddingVertical?: number;
  readonly width?: StyleDim;
  readonly height?: StyleDim;
  /** v1: absolute and relative are equivalent, no native effect. */
  readonly position?: "absolute" | "relative";
  /** px, may be negative; LVGL translate so it composes with future flex parents. */
  readonly left?: number;
  /** px, may be negative; LVGL translate so it composes with future flex parents. */
  readonly top?: number;
  /** "none" hides without unmounting. */
  readonly display?: "flex" | "none";
  /** Setting justifyContent/alignItems/gap alone implies "column" (RN default). */
  readonly flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
  readonly justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | "space-around" | "space-evenly";
  /** No "stretch": LVGL flex has none; idiom is child height "100%". */
  readonly alignItems?: "flex-start" | "flex-end" | "center";
  /** px, row and column gap. */
  readonly gap?: number;
  /** 0..255 (LVGL uint8). Explicit flexGrow wins over flex. */
  readonly flexGrow?: number;
  /** RN shorthand, alias of flexGrow. */
  readonly flex?: number;
  /** 0..1, clamped; plain LVGL opa (per-draw-op), not CSS group opacity. */
  readonly opacity?: number;
  /** Degrees clockwise, center pivot. */
  readonly rotate?: number | `${number}deg`;
  /** 1 = 100%, center pivot. */
  readonly scale?: number;
}

export interface TextStyle extends ViewStyle {
  readonly color?: StyleColor;
  readonly textAlign?: "left" | "center" | "right";
}

/** A screen has no parent to size/position/hide itself against; S2 size/position/display keys don't apply. */
export type ScreenStyle = Omit<ViewStyle, "position" | "left" | "top" | "width" | "height" | "display">;

/** RN-style style prop: a single style object, or an array where later entries win and falsy entries are skipped. */
export type StyleProp<T> = T | ReadonlyArray<T | false | null | undefined>;

/** `extends Record<ElementType, object>` fails the build if a tag has no props. */
export interface WidgetProps extends Record<ElementType, object> {
  readonly Screen: { readonly children?: VNodeChild; readonly style?: StyleProp<ScreenStyle> };
  readonly View: { readonly children?: VNodeChild; readonly style?: StyleProp<ViewStyle> };
  readonly Text: { readonly text: string | number; readonly style?: StyleProp<TextStyle> };
  readonly Button: { readonly label: string; readonly onClick?: () => void; readonly style?: StyleProp<TextStyle> };
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

/** Freezes each style object and the sheet itself; mirrors React Native's `StyleSheet.create`. */
export const StyleSheet = Object.freeze({
  create<T extends Record<string, TextStyle>>(styles: T): Readonly<T> {
    for (const key of Object.keys(styles)) Object.freeze(styles[key]);
    return Object.freeze(styles);
  },
});

/** One descriptor keeps the SDK facade and device module resolver in lockstep. */
export const APPLICATION_FACADE_KEYS = [
  "Button",
  "Fragment",
  "Screen",
  "StyleSheet",
  "Text",
  "View",
  "isShake",
  "useEffect",
  "useInterval",
  "useMotion",
  "useWifi",
  "useState",
] as const;

export type ApplicationFacadeKey = (typeof APPLICATION_FACADE_KEYS)[number];
export type ApplicationFacadeBindings = { readonly [key in ApplicationFacadeKey]: unknown };

/** Internal construction seam shared by the SDK facade and the on-device resolver. */
export function createApplicationFacade<Bindings>(bindings: Bindings & ApplicationFacadeBindings): Readonly<Bindings> {
  return Object.freeze(bindings);
}

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
