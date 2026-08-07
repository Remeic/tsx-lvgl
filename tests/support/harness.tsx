/**
 * Shared fakes and helpers for the runtime test suite. Not a `*.test.*` file,
 * so `node --test` does not pick it up on its own.
 */
import type { ElementType } from "@tsx-lvgl/core";
import {
  Runtime,
  type RuntimeHost,
  type RuntimeHostInstance,
  type RuntimeScheduler,
} from "@tsx-lvgl/runtime";
import {
  createSensorRegistry,
  type DeviceCapabilities,
  type Sensor,
  type SensorContext,
  type SensorSample,
  type SensorSchema,
} from "@tsx-lvgl/sensors";
import { strict as assert } from "node:assert";

import { advanceTimers } from "./time.js";

export interface FakeInstance extends RuntimeHostInstance {
  readonly id: number;
  props: Readonly<Record<string, unknown>>;
  readonly children: FakeInstance[];
  parent: FakeInstance | null;
  disposed: boolean;
}

/**
 * Records every operation the reconciler submits so tests can assert on
 * ordering, counts, and prop diffs without a real LVGL binding.
 */
export class FakeHost implements RuntimeHost {
  private nextId = 1;
  readonly roots: FakeInstance[] = [];
  readonly created: FakeInstance[] = [];
  readonly replacedRoots: Array<{ previous: FakeInstance | null; next: FakeInstance | null }> = [];
  readonly rootInsertionsOutsideReplace: FakeInstance[] = [];
  readonly insertions: Array<{ parent: FakeInstance | null; child: FakeInstance; index: number }> = [];
  readonly updates: Array<{
    instance: FakeInstance;
    previousProps: Readonly<Record<string, unknown>>;
    nextProps: Readonly<Record<string, unknown>>;
  }> = [];
  readonly removals: Array<{ parent: FakeInstance | null; child: FakeInstance }> = [];
  readonly disposals: FakeInstance[] = [];
  private replacingRoot = false;

  createInstance(type: ElementType, props: Readonly<Record<string, unknown>>): FakeInstance {
    const instance: FakeInstance = {
      id: this.nextId++,
      type,
      props,
      children: [],
      parent: null,
      disposed: false,
    };
    this.created.push(instance);
    return instance;
  }

  insertChild(parent: RuntimeHostInstance | null, child: RuntimeHostInstance, index: number): void {
    const parentInstance = parent as FakeInstance | null;
    const childInstance = child as FakeInstance;
    if (parentInstance === null && !this.replacingRoot) this.rootInsertionsOutsideReplace.push(childInstance);
    this.removeFromCurrentParent(childInstance);
    const children = parentInstance?.children ?? this.roots;
    const boundedIndex = Math.max(0, Math.min(index, children.length));
    children.splice(boundedIndex, 0, childInstance);
    childInstance.parent = parentInstance;
    this.insertions.push({ parent: parentInstance, child: childInstance, index: boundedIndex });
  }

  updateInstance(
    instance: RuntimeHostInstance,
    _type: ElementType,
    previousProps: Readonly<Record<string, unknown>>,
    nextProps: Readonly<Record<string, unknown>>,
  ): void {
    this.updates.push({ instance: instance as FakeInstance, previousProps, nextProps });
    (instance as FakeInstance).props = nextProps;
  }

  removeChild(parent: RuntimeHostInstance | null, child: RuntimeHostInstance): void {
    const parentInstance = parent as FakeInstance | null;
    const children = parentInstance?.children ?? this.roots;
    const index = children.indexOf(child as FakeInstance);
    if (index >= 0) children.splice(index, 1);
    (child as FakeInstance).parent = null;
    this.removals.push({ parent: parentInstance, child: child as FakeInstance });
  }

  dispose(instance: RuntimeHostInstance): void {
    const target = instance as FakeInstance;
    target.disposed = true;
    this.disposals.push(target);
  }

  replaceRoot(next: RuntimeHostInstance | null, previous: RuntimeHostInstance | null): void {
    const nextInstance = next as FakeInstance | null;
    const previousInstance = previous as FakeInstance | null;
    this.replacedRoots.push({ previous: previousInstance, next: nextInstance });
    this.replacingRoot = true;
    try {
      if (previousInstance) this.removeChild(null, previousInstance);
      if (nextInstance) this.insertChild(null, nextInstance, 0);
    } finally {
      this.replacingRoot = false;
    }
  }

  click(label: string): void {
    const button = this.created.find(
      (instance) => instance.type === "Button" && instance.props.label === label && !instance.disposed,
    );
    assert.ok(button, `button ${label} exists`);
    const onClick = button.props.onClick;
    assert.equal(typeof onClick, "function");
    (onClick as () => void)();
  }

  text(): string {
    return this.created
      .filter((instance) => instance.type === "Text" && !instance.disposed)
      .map((instance) => String(instance.props.text))
      .join(" | ");
  }

  /** Most recently created instance of `type`, regardless of disposal. */
  latest(type: ElementType): FakeInstance | undefined {
    return this.created.filter((instance) => instance.type === type).at(-1);
  }

  /** Most recently created, still-live instance of `type`. */
  live(type: ElementType): FakeInstance | undefined {
    return this.created.filter((instance) => instance.type === type && !instance.disposed).at(-1);
  }

  private removeFromCurrentParent(child: FakeInstance): void {
    const children = child.parent?.children ?? this.roots;
    const index = children.indexOf(child);
    if (index >= 0) children.splice(index, 1);
    child.parent = null;
  }
}

export class ManualScheduler implements RuntimeScheduler {
  private nextTimerId = 1;
  private readonly queued: Array<() => void> = [];
  private readonly timers = new Map<number, { callback: () => void; periodMs: number; elapsedMs: number }>();
  latestIntervalCallback: (() => void) | undefined;
  /** Every handle ever issued by `setInterval`, in order, to assert stability across renders. */
  readonly issuedHandles: number[] = [];

  enqueue(task: () => void): void {
    this.queued.push(task);
  }

  setInterval(callback: () => void, periodMs: number): number {
    const id = this.nextTimerId++;
    this.timers.set(id, { callback, periodMs, elapsedMs: 0 });
    this.latestIntervalCallback = callback;
    this.issuedHandles.push(id);
    return id;
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    advanceTimers(this.timers.values(), milliseconds);
  }

  flush(): void {
    while (this.queued.length > 0) this.queued.shift()?.();
  }

  get activeTimerCount(): number {
    return this.timers.size;
  }

  get queuedTaskCount(): number {
    return this.queued.length;
  }
}

export const uptimeSchema: SensorSchema<number> = {
  id: "board.uptime",
  version: 1,
  unit: "ms",
  validate: (value: unknown): value is number => typeof value === "number",
};

export function sample(
  context: SensorContext,
  sequence: number,
  value: number,
  schema: SensorSchema<number> = uptimeSchema,
): SensorSample<number> {
  return {
    sensorId: schema.id,
    schemaVersion: schema.version,
    sequence,
    sampledAtMs: value,
    reloadEpoch: context.reloadEpoch,
    status: "ok",
    value,
  };
}

export interface FakeSensorOptions {
  readonly schema?: SensorSchema<number>;
  /** When true, `read()` never resolves on its own; call `resolve`/`reject`. */
  readonly deferred?: boolean;
}

/**
 * One fake covers both the "resolves immediately" and "resolves on demand"
 * shapes the old suite split across two classes: `deferred: true` leaves
 * `read()` pending until `resolve()`/`reject()` is called.
 */
export class FakeSensor implements Sensor<number> {
  readonly schema: SensorSchema<number>;
  readonly contexts: SensorContext[] = [];
  readonly listeners: Array<(value: SensorSample<number>) => void> = [];
  unsubscribeCalls = 0;
  private readonly deferred: boolean;
  private pending: {
    resolve: (value: SensorSample<number>) => void;
    reject: (error: unknown) => void;
  } | undefined;

  constructor(options: FakeSensorOptions = {}) {
    this.schema = options.schema ?? uptimeSchema;
    this.deferred = options.deferred ?? false;
  }

  read(context: SensorContext): Promise<SensorSample<number>> {
    this.contexts.push(context);
    if (!this.deferred) return Promise.resolve(sample(context, 1, 10, this.schema));
    return new Promise<SensorSample<number>>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  subscribe(listener: (value: SensorSample<number>) => void, context: SensorContext): () => void {
    this.contexts.push(context);
    this.listeners.push(listener);
    return () => {
      this.unsubscribeCalls += 1;
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** Settles a pending deferred `read()`. No-op if nothing is pending. */
  resolve(value: SensorSample<number>): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(value);
  }

  /** Rejects a pending deferred `read()`. No-op if nothing is pending. */
  reject(error: unknown): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  emit(value: SensorSample<number>): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

export interface Harness {
  readonly host: FakeHost;
  readonly scheduler: ManualScheduler;
  readonly runtime: Runtime;
  readonly errors: unknown[];
}

export interface CreateHarnessOptions {
  readonly capabilities?: DeviceCapabilities;
  readonly onError?: (error: unknown) => void;
}

/**
 * The one place a `FakeHost` + `ManualScheduler` + `Runtime` triple is built.
 * `errors` collects whatever `onError` reports unless the caller supplies its
 * own handler.
 */
export function createHarness(options: CreateHarnessOptions = {}): Harness {
  const host = new FakeHost();
  const scheduler = new ManualScheduler();
  const errors: unknown[] = [];
  const runtime = new Runtime({
    host,
    scheduler,
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    onError: options.onError ?? ((error: unknown) => errors.push(error)),
  });
  return { host, scheduler, runtime, errors };
}

export function sensorCapabilities(...sensors: readonly Sensor<any>[]): DeviceCapabilities {
  return { sensors: createSensorRegistry(sensors) };
}
