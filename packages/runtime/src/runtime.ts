import type { VNode } from "@tsx-lvgl/core";
import { createSensorRegistry, type DeviceCapabilities } from "@tsx-lvgl/sensors";
import {
  validateRuntimeBundle,
  type RuntimeBundle,
  type RuntimeBundlePolicy,
  type RuntimeBundleRejection,
  type RuntimeEngine,
} from "./bundle.js";
import { Session, type RuntimeSession } from "./session.js";
import type { RuntimeContext, RuntimeHost, RuntimeScheduler } from "./host.js";

export interface RuntimeOptions {
  readonly host: RuntimeHost;
  readonly scheduler: RuntimeScheduler;
  readonly capabilities?: DeviceCapabilities;
  readonly onError?: (error: unknown) => void;
}

export type ReloadResult =
  | { readonly status: "committed"; readonly epoch: number }
  | { readonly status: "rolled_back"; readonly epoch: number; readonly error: unknown };

export type BundleReloadResult = ReloadResult | {
  readonly status: "rejected";
  readonly reason: RuntimeBundleRejection;
};

const noCapabilities: DeviceCapabilities = { sensors: createSensorRegistry([]) };

export class Runtime implements RuntimeContext {
  private activeSession: Session | null = null;
  private currentEpoch = 0;

  public constructor(private readonly options: RuntimeOptions) {}

  public get epoch(): number {
    return this.currentEpoch;
  }

  public get host(): RuntimeHost {
    return this.options.host;
  }

  public get scheduler(): RuntimeScheduler {
    return this.options.scheduler;
  }

  public get capabilities(): DeviceCapabilities {
    return this.options.capabilities ?? noCapabilities;
  }

  public mount(root: VNode): RuntimeSession {
    if (this.activeSession !== null) throw new Error("Runtime already has a mounted root");
    const result = this.commit(root);
    if (result.status === "rolled_back") throw result.error;
    return this.activeSession!;
  }

  public reload(root: VNode): ReloadResult {
    return this.commit(root);
  }

  /** Validates and evaluates staged bytes before entering the VNode reload seam. */
  public reloadBundle(
    bundle: RuntimeBundle,
    policy: RuntimeBundlePolicy,
    engine: RuntimeEngine,
  ): BundleReloadResult {
    const validation = validateRuntimeBundle(bundle, policy);
    if (!validation.ok) return { status: "rejected", reason: validation.reason };
    if (engine.name !== validation.bundle.manifest.engine) {
      return { status: "rejected", reason: "engine-mismatch" };
    }

    try {
      const root = engine.evaluate(validation.bundle.source, validation.bundle.manifest);
      return this.reload(root);
    } catch (error) {
      return { status: "rolled_back", epoch: this.currentEpoch, error };
    }
  }

  public unmount(): void {
    const session = this.activeSession;
    if (session === null) return;
    this.options.host.replaceRoot(null, session.rootHost);
    session.detach();
    session.dispose();
    this.activeSession = null;
  }

  public reportError(error: unknown): void {
    this.options.onError?.(error);
  }

  public sessionDisposed(session: object): void {
    if (this.activeSession === session) this.activeSession = null;
  }

  /**
   * The single root-swap transaction shared by mount and reload: build the
   * candidate off the active root, swap once, activate, and only then retire
   * the previous epoch. Any failure restores the previous root and epoch.
   */
  private commit(root: VNode): ReloadResult {
    const previous = this.activeSession;
    const candidate = new Session(this, root, this.currentEpoch + 1);

    try {
      candidate.build();
      this.options.host.replaceRoot(candidate.rootHost, previous?.rootHost ?? null);
      candidate.attach();
      try {
        candidate.flushEffects();
      } catch (error) {
        this.options.host.replaceRoot(previous?.rootHost ?? null, candidate.rootHost);
        candidate.detach();
        candidate.dispose();
        return { status: "rolled_back", epoch: this.currentEpoch, error };
      }

      this.activeSession = candidate;
      this.currentEpoch = candidate.epoch;
      try {
        previous?.dispose();
      } catch (error) {
        this.reportError(error);
      }
      return { status: "committed", epoch: candidate.epoch };
    } catch (error) {
      candidate.dispose();
      return { status: "rolled_back", epoch: this.currentEpoch, error };
    }
  }
}
