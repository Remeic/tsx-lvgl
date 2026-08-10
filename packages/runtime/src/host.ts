import type { ElementType } from "@tsx-lvgl/core";
import type { DeviceCapabilities } from "@tsx-lvgl/sensors";
import type { CapabilityRuntime } from "@tsx-lvgl/capabilities";
import type { WifiService } from "@tsx-lvgl/connectivity";

export interface RuntimeHostInstance {
  readonly type: ElementType;
}

/**
 * The only LVGL-facing seam. Implementations own thread affinity and native
 * handle lifetime; the reconciler only submits ordered operations.
 *
 * `replaceRoot` is a distinct operation rather than a remove/insert pair
 * because loading a screen is a distinct LVGL operation (`lv_screen_load`),
 * and it is the atomicity boundary the reload transaction depends on.
 */
export interface RuntimeHost {
  createInstance(type: ElementType, props: Readonly<Record<string, unknown>>): RuntimeHostInstance;
  insertChild(parent: RuntimeHostInstance | null, child: RuntimeHostInstance, index: number): void;
  updateInstance(
    instance: RuntimeHostInstance,
    type: ElementType,
    previousProps: Readonly<Record<string, unknown>>,
    nextProps: Readonly<Record<string, unknown>>,
  ): void;
  removeChild(parent: RuntimeHostInstance | null, child: RuntimeHostInstance): void;
  dispose(instance: RuntimeHostInstance): void;
  replaceRoot(next: RuntimeHostInstance | null, previous: RuntimeHostInstance | null): void;
}

export interface RuntimeScheduler {
  enqueue(task: () => void): void;
  setInterval(task: () => void, periodMs: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * What a session needs from its owning runtime. Keeping it an interface is what
 * lets `session.ts` stay free of any import from `runtime.ts`.
 */
export interface RuntimeContext {
  readonly host: RuntimeHost;
  readonly scheduler: RuntimeScheduler;
  readonly capabilities: DeviceCapabilities;
  readonly board: CapabilityRuntime;
  readonly wifi: WifiService | undefined;
  reportError(error: unknown): void;
  sessionDisposed(session: object): void;
}
