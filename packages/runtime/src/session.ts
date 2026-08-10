import type { VNode } from "@tsx-lvgl/core";
import type { CapabilityRuntime } from "@tsx-lvgl/capabilities";
import type { DeviceCapabilities } from "@tsx-lvgl/sensors";
import {
  mountFiber,
  reconcileFiber,
  singleHostRoot,
  syncHostAncestor,
  unmountFiber,
  type Fiber,
} from "./fiber.js";
import type { Cleanup, EffectHook } from "./hooks.js";
import type { RuntimeContext, RuntimeHost, RuntimeHostInstance, RuntimeScheduler } from "./host.js";

/** One reload epoch: a tree, its hooks, its timers and its host instances. */
export interface RuntimeSession {
  readonly epoch: number;
  readonly root: VNode;
  dispose(): void;
}

export class Session implements RuntimeSession {
  private rootFiber: Fiber | null = null;
  private hostRoot: RuntimeHostInstance | undefined;
  private attached = false;
  private disposed = false;
  private flushQueued = false;
  private readonly pendingEffects: EffectHook[] = [];
  private readonly dirty = new Set<Fiber>();

  public constructor(
    private readonly context: RuntimeContext,
    public readonly root: VNode,
    public readonly epoch: number,
  ) {}

  public get host(): RuntimeHost {
    return this.context.host;
  }

  public get scheduler(): RuntimeScheduler {
    return this.context.scheduler;
  }

  public get capabilities(): DeviceCapabilities {
    return this.context.capabilities;
  }

  public get board(): CapabilityRuntime {
    return this.context.board;
  }

  public get rootHost(): RuntimeHostInstance {
    return this.hostRoot!;
  }

  /** Builds the candidate tree without touching the active root. */
  public build(): void {
    this.rootFiber = mountFiber(this, this.root, null);
    this.hostRoot = singleHostRoot(this.rootFiber);
  }

  public attach(): void {
    this.attached = true;
  }

  public detach(): void {
    this.attached = false;
  }

  public isAttached(): boolean {
    return this.attached;
  }

  public isActive(): boolean {
    return !this.disposed;
  }

  public reportError(error: unknown): void {
    this.context.reportError(error);
  }

  /** The session fence is repeated here for stale host callbacks. */
  public requestUpdate(fiber: Fiber): void {
    if (this.disposed || !fiber.active) return;
    this.dirty.add(fiber);
    if (this.flushQueued) return;
    this.flushQueued = true;
    this.context.scheduler.enqueue(() => this.flush());
  }

  public enqueueEffect(hook: EffectHook): void {
    this.pendingEffects.push(hook);
  }

  /**
   * Runs pending effects. Cleanups run before their effect, and a throwing
   * effect leaves the untouched remainder queued for the next flush.
   */
  public flushEffects(): void {
    const pending = this.pendingEffects;
    let cursor = 0;
    try {
      for (const [index, hook] of pending.entries()) {
        cursor = index + 1;
        const cleanup = hook.cleanup;
        hook.cleanup = undefined;
        cleanup?.();
        hook.cleanup = hook.effect() as Cleanup | undefined;
      }
    } finally {
      pending.splice(0, cursor);
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.rootFiber !== null) {
      unmountFiber(this, this.rootFiber);
      this.rootFiber = null;
    }
    this.pendingEffects.length = 0;
    this.dirty.clear();
    this.attached = false;
    this.context.sessionDisposed(this);
  }

  /** Re-renders only the fibers whose state changed, shallowest first. */
  private flush(): void {
    this.flushQueued = false;
    const targets = [...this.dirty].sort((left, right) => left.depth - right.depth);
    this.dirty.clear();
    const rendered = new Set<Fiber>();
    try {
      for (const fiber of targets) {
        if (!fiber.active || hasRenderedAncestor(fiber, rendered)) continue;
        reconcileFiber(this, fiber, fiber.vnode);
        syncHostAncestor(this, fiber);
        rendered.add(fiber);
      }
      this.flushEffects();
    } catch (error) {
      this.context.reportError(error);
    }
  }
}

function hasRenderedAncestor(fiber: Fiber, rendered: ReadonlySet<Fiber>): boolean {
  for (let ancestor = fiber.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (rendered.has(ancestor)) return true;
  }
  return false;
}
