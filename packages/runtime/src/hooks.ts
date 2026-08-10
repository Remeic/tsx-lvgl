import { motionSchema, subscribeSensor, type MotionSample, type SensorSample, type SensorSchema } from "@tsx-lvgl/sensors";
import type { CapabilityBinding, CapabilityObserveOptions } from "@tsx-lvgl/capabilities";
import type { CapabilityState, OperationId, OperationState } from "@tsx-lvgl/capabilities";
import type { ConnectivityContext, EphemeralWifiConnectRequest, WifiController, WifiLink, WifiNetwork, WifiOperation, WifiScanRequest, WifiService } from "@tsx-lvgl/connectivity";
import type { Fiber } from "./fiber.js";
import type { Session } from "./session.js";

type StateUpdate<T> = T | ((previous: T) => T);
export type StateSetter<T> = (update: StateUpdate<T>) => void;
export type Cleanup = () => void;
export type Effect = () => void | Cleanup;

interface StateHook<T> {
  readonly kind: "state";
  value: T;
  readonly setter: StateSetter<T>;
}

export interface EffectHook {
  readonly kind: "effect";
  dependencies: readonly unknown[] | undefined;
  effect: Effect;
  cleanup: Cleanup | undefined;
}

export type Hook = StateHook<unknown> | EffectHook;

// Module-level rather than a context object so a render costs no allocation.
let currentSession: Session | null = null;
let currentFiber: Fiber | null = null;

/** Runs `render` with the hook slots of `fiber` bound, restoring any outer render. */
export function renderWithHooks<T>(session: Session, fiber: Fiber, render: () => T): T {
  const previousSession = currentSession;
  const previousFiber = currentFiber;
  currentSession = session;
  currentFiber = fiber;
  fiber.hookIndex = 0;
  try {
    return render();
  } finally {
    currentSession = previousSession;
    currentFiber = previousFiber;
  }
}

export function useState<T>(initial: T | (() => T)): [T, StateSetter<T>] {
  const fiber = requireFiber("useState");
  const session = currentSession as Session;
  const hooks = fiber.hooks ??= [];
  const index = fiber.hookIndex++;
  const existing = hooks[index];

  if (existing === undefined) {
    const hook: StateHook<T> = {
      kind: "state",
      value: typeof initial === "function" ? (initial as () => T)() : initial,
      setter: (update: StateUpdate<T>): void => {
        if (!session.isActive() || !fiber.active) return;
        const next = typeof update === "function"
          ? (update as (previous: T) => T)(hook.value)
          : update;
        if (Object.is(next, hook.value)) return;
        hook.value = next;
        session.requestUpdate(fiber);
      },
    };
    hooks[index] = hook as StateHook<unknown>;
    return [hook.value, hook.setter];
  }

  if (existing.kind !== "state") throw new Error("Hook order changed: expected state hook");
  const hook = existing as StateHook<T>;
  return [hook.value, hook.setter];
}

export function useEffect(effect: Effect, dependencies?: readonly unknown[]): void {
  const fiber = requireFiber("useEffect");
  const session = currentSession as Session;
  const hooks = fiber.hooks ??= [];
  const index = fiber.hookIndex++;
  const existing = hooks[index];

  if (existing === undefined) {
    const hook: EffectHook = { kind: "effect", dependencies, effect, cleanup: undefined };
    hooks[index] = hook;
    session.enqueueEffect(hook);
    return;
  }

  if (existing.kind !== "effect") throw new Error("Hook order changed: expected effect hook");
  const changed = dependencies === undefined || existing.dependencies === undefined
    ? true
    : !sameDependencies(existing.dependencies, dependencies);
  if (!changed) return;
  existing.dependencies = dependencies;
  existing.effect = effect;
  session.enqueueEffect(existing);
}

/**
 * The timer is created once per mount: the callback is read through a mutable
 * slot so an inline arrow does not tear down and restart the native timer on
 * every render.
 */
export function useInterval(callback: () => void, periodMs: number): void {
  if (!Number.isInteger(periodMs) || periodMs <= 0) {
    throw new Error("useInterval period must be a positive integer");
  }
  const fiber = requireFiber("useInterval");
  const session = currentSession as Session;
  const [slot] = useState(() => createCallbackSlot(callback));
  slot.callback = callback;

  useEffect(() => {
    const handle = session.scheduler.setInterval(() => {
      if (session.isActive() && fiber.active) slot.callback();
    }, periodMs);
    return () => session.scheduler.clearInterval(handle);
  }, [periodMs]);
}

export function useSensor<T>(schema: SensorSchema<T>): SensorSample<T> | undefined {
  requireFiber("useSensor");
  const session = currentSession as Session;
  const sensor = session.capabilities.sensors.get(schema);
  const [sample, setSample] = useState<SensorSample<T> | undefined>(undefined);

  useEffect(() => {
    if (sensor === undefined) return;
    const subscription = subscribeSensor(
      sensor,
      session.epoch,
      setSample,
      (error: unknown) => session.reportError(error),
    );
    return () => subscription.cancel();
  }, [sensor]);

  return sample;
}

/** Board motion prefers the boot-frozen capability catalog and never starts a provider from render. */
export function useMotion(options: CapabilityObserveOptions = {}): CapabilityBinding<MotionSample> {
  requireFiber("useMotion");
  const session = currentSession as Session;
  const [binding, setBinding] = useState<CapabilityBinding<MotionSample>>(() => session.board.getBinding(motionSchema, options));
  useEffect(() => {
    const subscription = session.board.subscribe(motionSchema, options, { reloadEpoch: session.epoch, isCancelled: () => !session.isActive() }, setBinding);
    return () => subscription.cancel();
  }, [options.enabled, options.instanceId, options.periodMs]);
  return binding;
}

/** Station state is device-owned; this hook owns only its subscription and in-flight commands. */
export function useWifi(): WifiController {
  const fiber = requireFiber("useWifi");
  const session = currentSession as Session;
  const [, invalidate] = useState(0);
  const [holder] = useState(() => createWifiHolder(session.wifi));
  const [controller] = useState(() => createWifiController(holder, session, fiber, invalidate));
  useEffect(() => {
    holder.wifi = session.wifi;
    holder.state = holder.wifi?.getState() ?? unsupportedWifiState();
    invalidate((value) => value + 1);
    if (holder.wifi === undefined) return;
    const unsubscribe = holder.wifi.subscribe((state) => { holder.state = state; invalidate((value) => value + 1); }, wifiContext(session, fiber));
    return () => {
      unsubscribe();
      holder.scanUnsubscribe?.(); holder.scanUnsubscribe = undefined; holder.scanOperation?.cancel(); holder.scanOperation = undefined;
      holder.connectionUnsubscribe?.(); holder.connectionUnsubscribe = undefined; holder.connectionOperation?.cancel(); holder.connectionOperation = undefined;
    };
  }, [session.wifi, session.epoch]);
  return controller;
}

interface WifiHolder {
  wifi: WifiService | undefined;
  state: CapabilityState<WifiLink>;
  scan: OperationState<readonly WifiNetwork[]>;
  connection: OperationState<void>;
  nextUnsupportedId: number;
  scanOperation: WifiOperation<readonly WifiNetwork[]> | undefined;
  connectionOperation: WifiOperation<void> | undefined;
  scanUnsubscribe: (() => void) | undefined;
  connectionUnsubscribe: (() => void) | undefined;
}
function createWifiHolder(wifi: WifiService | undefined): WifiHolder { return { wifi, state: wifi?.getState() ?? unsupportedWifiState(), scan: { status: "idle" }, connection: { status: "idle" }, nextUnsupportedId: 1, scanOperation: undefined, connectionOperation: undefined, scanUnsubscribe: undefined, connectionUnsubscribe: undefined }; }
function createWifiController(holder: WifiHolder, session: Session, fiber: Fiber, invalidate: StateSetter<number>): WifiController {
  const update = (): void => invalidate((value) => value + 1);
  const attachScan = (operation: WifiOperation<readonly WifiNetwork[]>): OperationId => { holder.scanUnsubscribe?.(); holder.scanOperation?.cancel(); holder.scanOperation = operation; holder.scan = { status: "running", id: operation.id }; holder.scanUnsubscribe = operation.subscribe((state) => { holder.scan = state; update(); }); update(); return operation.id; };
  const attachConnection = (operation: WifiOperation<void>): OperationId => { holder.connectionUnsubscribe?.(); holder.connectionOperation?.cancel(); holder.connectionOperation = operation; holder.connection = { status: "running", id: operation.id }; holder.connectionUnsubscribe = operation.subscribe((state) => { holder.connection = state; update(); }); update(); return operation.id; };
  return Object.freeze({
    get state(): CapabilityState<WifiLink> { return holder.state; }, get scan(): OperationState<readonly WifiNetwork[]> { return holder.scan; }, get connection(): OperationState<void> { return holder.connection; },
    scanNetworks(request: WifiScanRequest = {}): OperationId { const wifi = holder.wifi; return attachScan(wifi === undefined ? unsupportedOperation(holder, "wifi-unavailable") : wifi.scan(request, wifiContext(session, fiber))); },
    cancelScan(): void { holder.scanOperation?.cancel(); },
    connect(request: EphemeralWifiConnectRequest): OperationId { const wifi = holder.wifi; return attachConnection(wifi === undefined ? unsupportedOperation(holder, "wifi-unavailable") : wifi.connect(request, wifiContext(session, fiber))); },
    disconnect(): OperationId { const wifi = holder.wifi; return attachConnection(wifi === undefined ? unsupportedOperation(holder, "wifi-unavailable") : wifi.disconnect(wifiContext(session, fiber))); },
  });
}
function wifiContext(session: Session, fiber: Fiber): ConnectivityContext { return { reloadEpoch: session.epoch, isCancelled: () => !session.isActive() || !fiber.active }; }
function unsupportedWifiState(): CapabilityState<WifiLink> { return { status: "unsupported", reason: "not-implemented" }; }
function unsupportedOperation<T>(holder: WifiHolder, diagnosticId: string): WifiOperation<T> { const id = holder.nextUnsupportedId++ as OperationId; const state: OperationState<T> = { status: "failed", id, issue: { code: "unsupported", retry: "never", diagnosticId } }; return { id, cancel: () => undefined, subscribe(listener) { listener(state); return () => undefined; } }; }

/** Runs the cleanup of every effect hook a fiber owns, exactly once. */
export function releaseHooks(hooks: readonly Hook[]): void {
  let firstError: unknown;
  let hasError = false;
  for (const hook of hooks) {
    switch (hook.kind) {
      case "effect": {
        const cleanup = hook.cleanup;
        hook.cleanup = undefined;
        try {
          cleanup?.();
        } catch (error) {
          if (!hasError) {
            firstError = error;
            hasError = true;
          }
        }
        break;
      }
    }
  }
  if (hasError) throw firstError;
}

function createCallbackSlot(callback: () => void): { callback: () => void } {
  const slot = Object.create(null) as { callback: () => void };
  slot.callback = callback;
  return slot;
}

function requireFiber(name: string): Fiber {
  if (currentFiber === null) throw new Error(`${name} must be called while rendering a component`);
  return currentFiber;
}

function sameDependencies(previous: readonly unknown[], next: readonly unknown[]): boolean {
  if (previous.length !== next.length) return false;
  for (const [index, dependency] of next.entries()) {
    if (!Object.is(previous[index], dependency)) return false;
  }
  return true;
}
