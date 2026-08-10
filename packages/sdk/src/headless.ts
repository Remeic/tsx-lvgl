import { createKernel, type NativeBindings, type NativeWidgetKind } from "@tsx-lvgl/device";
import type { RuntimeBundle } from "@tsx-lvgl/runtime";

interface HeadlessNode {
  readonly id: number;
  readonly kind: NativeWidgetKind;
  text: string | undefined;
  parent: number | null;
  readonly children: number[];
}
export interface HeadlessResult {
  readonly texts: readonly string[];
  readonly logs: readonly string[];
  readonly generation: number;
}

/**
 * Runs the same device kernel against a deterministic in-memory native ABI.
 * This is a developer check, not a simulator or a physical-board adapter.
 */
export async function runHeadless(bundle: RuntimeBundle, boardId: string): Promise<HeadlessResult> {
  const host = createHeadlessNative(boardId);
  const kernel = createKernel(host.native);
  kernel.start(bundle);
  await Promise.resolve();
  await Promise.resolve();
  kernel.pump();
  return {
    texts: host.activeTexts(),
    logs: host.logs,
    generation: kernel.lastGeneration(),
  };
}

export function createHeadlessNative(boardId: string): {
  readonly native: NativeBindings;
  readonly logs: string[];
  activeTexts(): readonly string[];
} {
  const nodes = new Map<number, HeadlessNode>();
  const logs: string[] = [];
  let nextNodeId = 1;
  let activeScreen = 0;
  let clickDispatch: ((id: number) => void) | undefined;

  const lvgl = {
    create(kind: NativeWidgetKind): number {
      const id = nextNodeId++;
      nodes.set(id, { id, kind, text: undefined, parent: null, children: [] });
      return id;
    },

    insert(parentId: number, childId: number, index: number): void {
      const parent = requireNode(nodes, parentId);
      const child = requireNode(nodes, childId);
      detach(nodes, child);
      const bounded = Math.max(0, Math.min(index, parent.children.length));
      parent.children.splice(bounded, 0, child.id);
      child.parent = parent.id;
    },

    setText(id: number, text: string): void {
      requireNode(nodes, id).text = text;
    },

    setClickable(_id: number, _clickable: boolean): void {
      // Click dispatch is part of the kernel contract; the one-shot dev check
      // intentionally renders the initial state without synthesizing input.
    },

    remove(parentId: number, childId: number): void {
      const parent = requireNode(nodes, parentId);
      const index = parent.children.indexOf(childId);
      if (index >= 0) parent.children.splice(index, 1);
      const child = nodes.get(childId);
      if (child !== undefined) child.parent = null;
    },

    dispose(id: number): void {
      const node = nodes.get(id);
      if (node === undefined) return;
      for (const childId of [...node.children]) lvgl.dispose(childId);
      nodes.delete(id);
    },

    loadScreen(id: number): void {
      activeScreen = id;
    },
  };

  let nextTimerId = 1;
  const timers = new Map<number, { readonly callback: () => void; readonly periodMs: number; elapsedMs: number }>();
  const nativeTimers = {
    setInterval(callback: () => void, periodMs: number): number {
      const id = nextTimerId++;
      timers.set(id, { callback, periodMs, elapsedMs: 0 });
      return id;
    },

    clearInterval(id: number): void {
      timers.delete(id);
    },
  };

  const native: NativeBindings = {
    boardId,
    lvgl,
    timers: nativeTimers,
    sensors: {
      read(sensorId: string): unknown {
        if (sensorId !== "board.qmi8658.motion") {
          return { status: "unavailable", sampledAtMs: 0 };
        }
        return {
          status: "ok",
          sampledAtMs: 0,
          value: {
            accelerationMps2: [0, 0, 9.80665],
            angularVelocityDps: [0, 0, 0],
          },
        };
      },
    },
    onClick(dispatch): void {
      clickDispatch = dispatch;
    },
    log(message): void {
      logs.push(message);
    },
  };

  // Keep the callback variable live so the native ABI shape is exercised even
  // though the deterministic dev command does not inject a click.
  void clickDispatch;

  return {
    native,
    logs,
    activeTexts(): readonly string[] {
      const result: string[] = [];
      collectTexts(nodes, activeScreen, result);
      return result;
    },
  };
}

function requireNode(nodes: ReadonlyMap<number, HeadlessNode>, id: number): HeadlessNode {
  const node = nodes.get(id);
  if (node === undefined) throw new Error(`headless native: unknown node ${id}`);
  return node;
}

function detach(nodes: ReadonlyMap<number, HeadlessNode>, child: HeadlessNode): void {
  if (child.parent === null) return;
  const parent = nodes.get(child.parent);
  if (parent !== undefined) {
    const index = parent.children.indexOf(child.id);
    if (index >= 0) parent.children.splice(index, 1);
  }
  child.parent = null;
}

function collectTexts(nodes: ReadonlyMap<number, HeadlessNode>, id: number, out: string[]): void {
  const node = nodes.get(id);
  if (node === undefined) return;
  if (node.text !== undefined) out.push(node.text);
  for (const childId of node.children) collectTexts(nodes, childId, out);
}
