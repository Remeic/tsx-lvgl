/**
 * Fakes for the device package's native ABI (`packages/device/src/native.ts`).
 * Not a `*.test.*` file, so `node --test` does not pick it up on its own.
 */
import type {
  NativeBindings,
  NativeLvgl,
  NativeSensors,
  NativeTimers,
  NativeWidgetKind,
} from "@tsx-lvgl/device";
import type { SensorStatus } from "@tsx-lvgl/sensors";

import { advanceTimers } from "./time.js";

interface FakeLvglNode {
  readonly id: number;
  readonly kind: NativeWidgetKind;
  text: string | undefined;
  clickable: boolean;
  parent: number | null;
  readonly children: number[];
  disposed: boolean;
}

/**
 * Records every call the reconciler-facing host submits and exposes small
 * query helpers so tests can assert on native widget tree shape without a
 * real LVGL binding.
 */
export class FakeNativeLvgl implements NativeLvgl {
  private nextId = 1;
  private readonly nodes = new Map<number, FakeLvglNode>();
  readonly setTextCalls: Array<{ readonly id: number; readonly text: string }> = [];
  readonly setClickableCalls: Array<{ readonly id: number; readonly clickable: boolean }> = [];
  readonly insertCalls: Array<{ readonly parent: number; readonly child: number; readonly index: number }> = [];
  readonly removeCalls: Array<{ readonly parent: number; readonly child: number }> = [];
  readonly disposeCalls: number[] = [];
  loadedScreen = 0;

  create(kind: NativeWidgetKind): number {
    const id = this.nextId++;
    this.nodes.set(id, { id, kind, text: undefined, clickable: false, parent: null, children: [], disposed: false });
    return id;
  }

  insert(parent: number, child: number, index: number): void {
    this.insertCalls.push({ parent, child, index });
    const parentNode = this.node(parent);
    const childNode = this.node(child);
    this.detach(childNode);
    const bounded = Math.max(0, Math.min(index, parentNode.children.length));
    parentNode.children.splice(bounded, 0, child);
    childNode.parent = parent;
  }

  setText(id: number, text: string): void {
    this.setTextCalls.push({ id, text });
    this.node(id).text = text;
  }

  setClickable(id: number, clickable: boolean): void {
    this.setClickableCalls.push({ id, clickable });
    this.node(id).clickable = clickable;
  }

  remove(parent: number, child: number): void {
    this.removeCalls.push({ parent, child });
    const parentNode = this.node(parent);
    const index = parentNode.children.indexOf(child);
    if (index >= 0) parentNode.children.splice(index, 1);
    this.node(child).parent = null;
  }

  dispose(id: number): void {
    const node = this.node(id);
    for (const child of [...node.children]) this.dispose(child);
    node.disposed = true;
    this.disposeCalls.push(id);
  }

  loadScreen(id: number): void {
    this.loadedScreen = id;
  }

  kindOf(id: number): NativeWidgetKind {
    return this.node(id).kind;
  }

  textOf(id: number): string | undefined {
    return this.node(id).text;
  }

  isClickable(id: number): boolean {
    return this.node(id).clickable;
  }

  isAlive(id: number): boolean {
    return !this.node(id).disposed;
  }

  parentOf(id: number): number | null {
    return this.node(id).parent;
  }

  childrenOf(id: number): readonly number[] {
    return this.node(id).children;
  }

  /** Every still-alive `"text"` widget's text, in creation order. Excludes Button labels. */
  liveTexts(): string[] {
    return [...this.nodes.values()]
      .filter((node) => node.kind === "text" && !node.disposed)
      .map((node) => node.text ?? "");
  }

  /** Ids of every still-alive widget of `kind`, in creation order. */
  liveIdsOfKind(kind: NativeWidgetKind): number[] {
    return [...this.nodes.values()]
      .filter((node) => node.kind === kind && !node.disposed)
      .map((node) => node.id);
  }

  private node(id: number): FakeLvglNode {
    const found = this.nodes.get(id);
    if (found === undefined) throw new Error(`unknown lvgl id ${id}`);
    return found;
  }

  private detach(node: FakeLvglNode): void {
    if (node.parent === null) return;
    const parentNode = this.node(node.parent);
    const index = parentNode.children.indexOf(node.id);
    if (index >= 0) parentNode.children.splice(index, 1);
    node.parent = null;
  }
}

interface FakeTimer {
  callback: () => void;
  periodMs: number;
  elapsedMs: number;
}

/** Mirrors `ManualScheduler` from `harness.tsx`: manual, deterministic time advance. */
export class FakeNativeTimers implements NativeTimers {
  private nextHandle = 1;
  private readonly timers = new Map<number, FakeTimer>();

  setInterval(cb: () => void, periodMs: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { callback: cb, periodMs, elapsedMs: 0 });
    return handle;
  }

  clearInterval(handle: number): void {
    this.timers.delete(handle);
  }

  advance(milliseconds: number): void {
    advanceTimers(this.timers.values(), milliseconds);
  }

  get activeCount(): number {
    return this.timers.size;
  }
}

export interface ScriptedSensorReading {
  readonly status: SensorStatus;
  readonly sampledAtMs: number;
  readonly value?: unknown;
}

/** Scripted, per-sensor-id readings for `NativeSensors.read`. */
export class FakeNativeSensors implements NativeSensors {
  private readonly readings = new Map<string, ScriptedSensorReading>();

  script(sensorId: string, reading: ScriptedSensorReading): void {
    this.readings.set(sensorId, reading);
  }

  read(sensorId: string): unknown {
    const reading = this.readings.get(sensorId);
    if (reading === undefined) throw new Error(`no scripted reading for ${sensorId}`);
    return reading;
  }
}

export interface FakeNative {
  readonly native: NativeBindings;
  readonly lvgl: FakeNativeLvgl;
  readonly timers: FakeNativeTimers;
  readonly sensors: FakeNativeSensors;
  readonly logs: string[];
  dispatchClick(id: number): void;
}

/** The one place a full `NativeBindings` fake is assembled for kernel tests. */
export function makeFakeNative(boardId: string = "esp32s3-waveshare-v1"): FakeNative {
  const lvgl = new FakeNativeLvgl();
  const timers = new FakeNativeTimers();
  const sensors = new FakeNativeSensors();
  const logs: string[] = [];
  let dispatch: ((id: number) => void) | undefined;

  const native: NativeBindings = {
    boardId,
    lvgl,
    timers,
    sensors,
    onClick(next: (id: number) => void): void {
      dispatch = next;
    },
    log(message: string): void {
      logs.push(message);
    },
  };

  return {
    native,
    lvgl,
    timers,
    sensors,
    logs,
    dispatchClick(id: number): void {
      dispatch?.(id);
    },
  };
}
