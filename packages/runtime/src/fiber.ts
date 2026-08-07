import { normalizeChildren, type Key, type VNode } from "@tsx-lvgl/core";
import type { RuntimeHostInstance } from "./host.js";
import { releaseHooks, renderWithHooks, type Hook } from "./hooks.js";
import type { Session } from "./session.js";

export interface Fiber {
  vnode: VNode;
  readonly parent: Fiber | null;
  readonly depth: number;
  readonly children: Fiber[];
  hooks: Hook[] | undefined;
  hookIndex: number;
  active: boolean;
  instance: RuntimeHostInstance | undefined;
  /** Host children last submitted for an element fiber, to skip no-op reorders. */
  hostOrder: readonly RuntimeHostInstance[] | undefined;
  /** Identity token of the reconcile pass that reused this fiber. */
  mark: symbol | undefined;
}

export function mountFiber(session: Session, vnode: VNode, parent: Fiber | null): Fiber {
  const fiber: Fiber = {
    vnode,
    parent,
    depth: parent === null ? 0 : parent.depth + 1,
    children: [],
    hooks: undefined,
    hookIndex: 0,
    active: true,
    instance: undefined,
    hostOrder: undefined,
    mark: undefined,
  };

  try {
    if (vnode.kind === "element") {
      fiber.instance = session.host.createInstance(vnode.type, vnode.props);
    }
    renderFiber(session, fiber);
    return fiber;
  } catch (error) {
    unmountFiber(session, fiber);
    throw error;
  }
}

export function reconcileFiber(session: Session, fiber: Fiber, vnode: VNode): void {
  const previous = fiber.vnode;
  fiber.vnode = vnode;
  if (vnode.kind === "element" && !sameProps(previous.props, vnode.props)) {
    session.host.updateInstance(fiber.instance!, vnode.type, previous.props, vnode.props);
  }
  renderFiber(session, fiber);
}

export function unmountFiber(session: Session, fiber: Fiber): void {
  fiber.active = false;
  for (const child of fiber.children) unmountFiber(session, child);
  fiber.children.length = 0;

  const hooks = fiber.hooks;
  if (hooks !== undefined) {
    fiber.hooks = undefined;
    try {
      releaseHooks(hooks);
    } catch (error) {
      session.reportError(error);
    }
  }

  const instance = fiber.instance;
  if (instance !== undefined) {
    const hostParent = findHostParent(fiber);
    const attached = hostParent === undefined
      ? session.isAttached()
      : hostParent.hostOrder?.includes(instance) === true;
    if (attached) {
      session.host.removeChild(hostParent?.instance ?? null, instance);
    }
    session.host.dispose(instance);
    fiber.instance = undefined;
  }
  fiber.hostOrder = undefined;
}

/**
 * Re-submits the host order of the nearest element ancestor. A subtree-scoped
 * re-render can add or remove host roots without its element ancestor being
 * reconciled, so the ancestor is resynchronised explicitly.
 */
export function syncHostAncestor(session: Session, fiber: Fiber): void {
  for (let ancestor = fiber.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.vnode.kind !== "element") continue;
    syncHostOrder(session, ancestor);
    return;
  }
}

export function collectHostRoots(fiber: Fiber, out: RuntimeHostInstance[]): void {
  if (fiber.vnode.kind === "element") {
    out.push(fiber.instance!);
    return;
  }
  for (const child of fiber.children) collectHostRoots(child, out);
}

export function singleHostRoot(fiber: Fiber): RuntimeHostInstance {
  const roots: RuntimeHostInstance[] = [];
  collectHostRoots(fiber, roots);
  if (roots.length !== 1) throw new Error("Runtime roots must resolve to exactly one host instance");
  return roots[0]!;
}

function renderFiber(session: Session, fiber: Fiber): void {
  const vnode = fiber.vnode;
  if (vnode.kind !== "component") {
    reconcileChildren(session, fiber, vnode.children);
    return;
  }
  const component = vnode.type;
  const output = renderWithHooks(session, fiber, () =>
    component({ ...vnode.props, children: vnode.children }));
  reconcileChildren(session, fiber, normalizeChildren([output]));
}

function reconcileChildren(session: Session, parent: Fiber, next: readonly VNode[]): void {
  const previousChildren = parent.children;
  assertUniqueKeys(next);
  const keyed = indexByKey(previousChildren);
  const stamp = Symbol("reconcile-pass");
  const reconciled: Fiber[] = [];
  const mounted: Fiber[] = [];

  try {
    for (let index = 0; index < next.length; index++) {
      const vnode = next[index]!;
      const match = findMatch(vnode, index, previousChildren, keyed);
      if (match === undefined) {
        const child = mountFiber(session, vnode, parent);
        mounted.push(child);
        reconciled.push(child);
        continue;
      }
      match.mark = stamp;
      reconcileFiber(session, match, vnode);
      reconciled.push(match);
    }

    for (const child of previousChildren) {
      if (child.mark !== stamp) unmountFiber(session, child);
    }
  } catch (error) {
    for (let index = mounted.length - 1; index >= 0; index--) {
      unmountFiber(session, mounted[index]!);
    }
    throw error;
  }

  previousChildren.length = 0;
  for (const fiber of reconciled) previousChildren.push(fiber);
  syncHostOrder(session, parent);
}

function findMatch(
  vnode: VNode,
  index: number,
  previousChildren: readonly Fiber[],
  keyed: ReadonlyMap<Key, Fiber>,
): Fiber | undefined {
  if (vnode.key !== null) {
    const candidate = keyed.get(vnode.key);
    return candidate !== undefined && candidate.vnode.type === vnode.type ? candidate : undefined;
  }
  const slot = previousChildren[index];
  return slot !== undefined && slot.vnode.key === null && slot.vnode.type === vnode.type
    ? slot
    : undefined;
}

function syncHostOrder(session: Session, parent: Fiber): void {
  if (parent.vnode.kind !== "element") return;
  const roots: RuntimeHostInstance[] = [];
  for (const child of parent.children) collectHostRoots(child, roots);
  if (sameInstances(parent.hostOrder, roots)) return;

  parent.hostOrder = roots;
  const parentInstance = parent.instance!;
  for (let index = 0; index < roots.length; index++) {
    session.host.insertChild(parentInstance, roots[index]!, index);
  }
}

function assertUniqueKeys(children: readonly VNode[]): void {
  let keys: Set<Key> | undefined;
  for (const child of children) {
    if (child.key === null) continue;
    keys ??= new Set<Key>();
    if (keys.has(child.key)) throw new Error(`Duplicate child key: ${String(child.key)}`);
    keys.add(child.key);
  }
}

function indexByKey(children: readonly Fiber[]): Map<Key, Fiber> {
  const keyed = new Map<Key, Fiber>();
  for (const child of children) {
    keyed.set(child.vnode.key, child);
  }
  return keyed;
}

function findHostParent(fiber: Fiber): Fiber | undefined {
  for (let ancestor = fiber.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.vnode.kind === "element") return ancestor;
  }
  return undefined;
}

function sameInstances(
  previous: readonly RuntimeHostInstance[] | undefined,
  next: readonly RuntimeHostInstance[],
): boolean {
  if (previous === undefined) return false;
  if (previous.length !== next.length) return false;
  return next.every((instance, index) => previous[index] === instance);
}

function sameProps(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): boolean {
  let count = 0;
  for (const key in next) {
    if (!Object.is(previous[key], next[key])) return false;
    count++;
  }
  return Object.keys(previous).length === count;
}
