import {
  createCapabilityCatalog,
  createCapabilityToken,
  isBoardIssue,
  issue,
  selectCapabilityInstance,
  type BoardDiagnosticsSnapshot,
  type BoardIssue,
  type CapabilityBinding,
  type CapabilityContext,
  type CapabilityEvent,
  type CapabilityObserveOptions,
  type CapabilityRuntime,
  type CapabilitySchema,
  type CapabilityState,
  type CapabilitySubscription,
} from "@tsx-lvgl/capabilities";
import { motionSchema } from "@tsx-lvgl/sensors";
import { decodeBoardPayload } from "./board-adapter.js";
import { DEFAULT_BOARD_SCHEMA_REGISTRY, type BoardSchemaRegistry } from "./board-schema-registry.js";
import type { BoardPlatformAdapter, NativeBoardEvent, NativeCapabilityDescriptor } from "./native.js";

interface Subscriber {
  readonly id: number;
  readonly context: CapabilityContext;
  readonly periodMs: number;
  readonly onState: (binding: CapabilityBinding<unknown>) => void;
  readonly onEvent?: (event: CapabilityEvent<unknown>) => void;
  active: boolean;
}

interface Producer {
  readonly descriptor: NativeCapabilityDescriptor;
  readonly schema: CapabilitySchema<unknown>;
  readonly subscribers: Map<number, Subscriber>;
  handle: number;
  reloadEpoch: number;
  periodMs: number;
  lastSequence: number;
  last?: Reading;
}

interface Reading {
  readonly status: "ready" | "stale" | "unavailable" | "error";
  readonly value?: unknown;
  readonly issue?: BoardIssue;
  readonly observedAtMs: number;
  readonly sequence: number;
  readonly droppedSincePrevious: number;
}

export interface BoardRuntimeLimits {
  readonly maxObservers: number;
  readonly maxSubscribers: number;
  readonly maxQueuedDeliveries: number;
}

export interface BoardRuntimeOptions {
  readonly registry?: BoardSchemaRegistry;
  readonly limits?: Partial<BoardRuntimeLimits>;
}

const DEFAULT_LIMITS: BoardRuntimeLimits = Object.freeze({
  maxObservers: 4,
  maxSubscribers: 16,
  maxQueuedDeliveries: 16,
});

/**
 * Multiplexes boot-declared observations. All transport callbacks are fenced
 * by the committed reload epoch; a failed candidate cannot receive or retain
 * a native observation after rollback.
 */
export class BoardRuntime implements CapabilityRuntime {
  public readonly catalog;
  private readonly descriptors = new Map<string, NativeCapabilityDescriptor[]>();
  private readonly producers = new Map<string, Producer>();
  private readonly handles = new Map<number, Producer>();
  private readonly limits: BoardRuntimeLimits;
  private nextId = 1;
  private committedEpoch = 0;
  private dropped = 0;
  private queueDepth = 0;
  private queueHighWater = 0;
  private lastIssue: BoardIssue | undefined;
  private disposed = false;

  public constructor(
    private readonly adapter: BoardPlatformAdapter,
    { registry = DEFAULT_BOARD_SCHEMA_REGISTRY, limits = {} }: BoardRuntimeOptions = {},
  ) {
    this.limits = resolveLimits(limits);
    const registrations: Array<{ token: ReturnType<typeof createCapabilityToken>; instance: { id: string; isDefault: boolean; source: string } }> = [];
    for (const descriptor of adapter.list()) {
      validateDescriptor(descriptor);
      const schema = registry.resolve(descriptor.semanticId, descriptor.version);
      if (schema === undefined) continue;
      const entries = this.descriptors.get(schema.id) ?? [];
      if (entries.some((entry) => entry.instanceId === descriptor.instanceId)) {
        throw new Error(`duplicate native capability descriptor: ${descriptor.instanceId}`);
      }
      entries.push(Object.freeze({ ...descriptor }));
      this.descriptors.set(schema.id, entries);
      registrations.push({
        token: createCapabilityToken({
          familyCode: descriptor.familyCode,
          semanticId: descriptor.semanticId,
          version: descriptor.version,
          delivery: descriptor.delivery,
          validate: schema.validate,
        }),
        instance: { id: descriptor.instanceId, isDefault: descriptor.isDefault, source: descriptor.source },
      });
    }
    this.catalog = createCapabilityCatalog(registrations);
    adapter.setSink((event) => this.handleEvent(event));
  }

  public getBinding<T>(schema: CapabilitySchema<T>, options: CapabilityObserveOptions = {}): CapabilityBinding<T> {
    const instances = this.instances(schema);
    const selected = selectCapabilityInstance(instances, options.instanceId);
    if (selected.status === "unsupported") return { state: { status: "unsupported", reason: selected.reason }, instances };
    if (selected.status === "ambiguous") return { state: selected, instances };
    const producer = this.producers.get(selected.instance.id);
    const cached = producer?.last ?? this.readCached(selected.instance.id, schema);
    return { state: cached === undefined ? { status: "starting" } : this.asState(cached), instances };
  }

  public subscribe<T>(
    schema: CapabilitySchema<T>,
    options: CapabilityObserveOptions,
    context: CapabilityContext,
    onState: (binding: CapabilityBinding<T>) => void,
    onEvent?: (event: CapabilityEvent<T>) => void,
  ): CapabilitySubscription {
    if (options.enabled === false) return { cancel: () => undefined };
    const initial = this.getBinding(schema, options);
    onState(initial);
    if (initial.state.status === "unsupported" || initial.state.status === "ambiguous") return { cancel: () => undefined };
    const instanceId = this.selectedInstance(schema, options);
    if (instanceId === undefined) return { cancel: () => undefined };
    if (this.subscriberCount() >= this.limits.maxSubscribers) {
      return this.rejectSubscription(schema, this.instances(schema), onState, "board-subscriber-budget");
    }
    const descriptor = (this.descriptors.get(schema.id) ?? []).find((entry) => entry.instanceId === instanceId)!;
    const requestedPeriodMs = boundPeriod(options.periodMs ?? descriptor.defaultPeriodMs, descriptor);
    let producer = this.producers.get(instanceId);
    if (producer === undefined) {
      if (this.producers.size >= this.limits.maxObservers) {
        return this.rejectSubscription(schema, this.instances(schema), onState, "board-observer-budget");
      }
      producer = this.createProducer(descriptor, schema, requestedPeriodMs, context.reloadEpoch);
      this.producers.set(instanceId, producer);
      this.handles.set(producer.handle, producer);
    } else {
      this.reconfigureProducer(producer, this.effectivePeriod(producer, requestedPeriodMs));
    }
    const subscriber: Subscriber = {
      id: this.nextId++,
      context,
      periodMs: requestedPeriodMs,
      onState: onState as (binding: CapabilityBinding<unknown>) => void,
      active: true,
      ...(onEvent === undefined ? {} : { onEvent: onEvent as (event: CapabilityEvent<unknown>) => void }),
    };
    producer.subscribers.set(subscriber.id, subscriber);
    return { cancel: () => this.cancelSubscriber(instanceId, producer!, subscriber) };
  }

  public diagnostics(): BoardDiagnosticsSnapshot {
    const effectivePeriodsMs: Record<string, number> = {};
    for (const [id, producer] of this.producers) effectivePeriodsMs[id] = producer.periodMs;
    return {
      effectivePeriodsMs,
      queueDepth: this.queueDepth,
      queueHighWater: this.queueHighWater,
      droppedEvents: this.dropped,
      activeOwners: [...this.producers.keys()],
      resourceUse: {
        observers: this.producers.size,
        subscribers: [...this.producers.values()].reduce((total, producer) => total + producer.subscribers.size, 0),
        observerBudget: this.limits.maxObservers,
        subscriberBudget: this.limits.maxSubscribers,
        queueBudget: this.limits.maxQueuedDeliveries,
      },
      ...(this.lastIssue === undefined ? {} : { lastIssue: this.lastIssue }),
    };
  }

  public commitEpoch(epoch: number): void {
    if (!isEpoch(epoch) || epoch <= this.committedEpoch) return;
    const pending: Array<{ producer: Producer; handle: number }> = [];
    try {
      for (const producer of this.producers.values()) {
        if (producer.reloadEpoch === epoch) continue;
        pending.push({
          producer,
          handle: this.adapter.submit({ version: 1, kind: "observe", instanceId: producer.descriptor.instanceId, periodMs: producer.periodMs, reloadEpoch: epoch }),
        });
      }
    } catch (error) {
      for (const move of pending) this.adapter.cancel(move.handle);
      throw error;
    }
    for (const move of pending) {
      this.adapter.cancel(move.producer.handle);
      this.handles.delete(move.producer.handle);
      move.producer.handle = move.handle;
      move.producer.reloadEpoch = epoch;
      move.producer.lastSequence = 0;
      this.handles.set(move.handle, move.producer);
    }
    this.committedEpoch = epoch;
  }

  public rollbackEpoch(epoch: number): void {
    if (!isEpoch(epoch)) return;
    for (const [instanceId, producer] of this.producers) {
      if (producer.reloadEpoch !== epoch || epoch <= this.committedEpoch) continue;
      this.adapter.cancel(producer.handle);
      this.handles.delete(producer.handle);
      this.producers.delete(instanceId);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const producer of this.producers.values()) this.adapter.cancel(producer.handle);
    this.producers.clear();
    this.handles.clear();
    this.adapter.dispose();
  }

  private createProducer(descriptor: NativeCapabilityDescriptor, schema: CapabilitySchema<unknown>, periodMs: number, reloadEpoch: number): Producer {
    const handle = this.adapter.submit({ version: 1, kind: "observe", instanceId: descriptor.instanceId, periodMs, reloadEpoch });
    return { descriptor, schema, subscribers: new Map(), handle, reloadEpoch, periodMs, lastSequence: 0 };
  }

  private cancelSubscriber(instanceId: string, producer: Producer, subscriber: Subscriber): void {
    if (!subscriber.active) return;
    subscriber.active = false;
    producer.subscribers.delete(subscriber.id);
    if (producer.subscribers.size !== 0) {
      this.reconfigureProducer(producer, this.effectivePeriod(producer));
      return;
    }
    this.adapter.cancel(producer.handle);
    this.handles.delete(producer.handle);
    this.producers.delete(instanceId);
  }

  private handleEvent(event: NativeBoardEvent): void {
    if (this.disposed) return;
    const producer = this.handles.get(event.handle);
    if (producer === undefined || !isEventValid(event, producer)) return this.reject("board-envelope");
    if (event.sequence <= producer.lastSequence) return this.reject("board-sequence");
    const reading = decodeReading(event, producer.schema);
    if (reading === undefined) return this.reject("board-reading");
    producer.lastSequence = event.sequence;
    producer.last = reading;
    if (reading.issue !== undefined) this.lastIssue = reading.issue;
    const subscribers = [...producer.subscribers.values()].filter((subscriber) => subscriber.active && !subscriber.context.isCancelled() && subscriber.context.reloadEpoch === this.committedEpoch);
    if (subscribers.length > this.limits.maxQueuedDeliveries) return this.reject("board-queue-budget");
    this.queueDepth = subscribers.length;
    this.queueHighWater = Math.max(this.queueHighWater, this.queueDepth);
    try {
      for (const subscriber of subscribers) this.deliver(subscriber, producer, reading);
    } finally {
      this.queueDepth = 0;
    }
  }

  private deliver(subscriber: Subscriber, producer: Producer, reading: Reading): void {
    const instances = this.instances(producer.schema);
    subscriber.onState({ state: this.asState(reading), instances });
    subscriber.onEvent?.({
      semanticId: producer.schema.id,
      schemaVersion: producer.schema.version,
      reloadEpoch: producer.reloadEpoch,
      status: reading.status === "ready" ? "ok" : reading.status,
      observedAtMs: reading.observedAtMs,
      sequence: reading.sequence,
      droppedSincePrevious: reading.droppedSincePrevious,
      ...(reading.value === undefined ? {} : { value: reading.value }),
      ...(reading.issue === undefined ? {} : { issue: reading.issue }),
    });
  }

  private readCached<T>(instanceId: string, schema: CapabilitySchema<T>): Reading | undefined {
    const event = this.adapter.readCached(instanceId);
    return event === undefined || !isCachedEventValid(event, 512) ? undefined : decodeReading(event, schema);
  }

  private subscriberCount(): number {
    return [...this.producers.values()].reduce((total, producer) => total + producer.subscribers.size, 0);
  }

  private effectivePeriod(producer: Producer, pendingPeriodMs?: number): number {
    const periods = [...producer.subscribers.values()].map((subscriber) => subscriber.periodMs);
    if (pendingPeriodMs !== undefined) periods.push(pendingPeriodMs);
    return Math.min(...periods);
  }

  /** Replaces the native observation only after its replacement has been admitted. */
  private reconfigureProducer(producer: Producer, periodMs: number): void {
    if (producer.periodMs === periodMs) return;
    const handle = this.adapter.submit({ version: 1, kind: "observe", instanceId: producer.descriptor.instanceId, periodMs, reloadEpoch: producer.reloadEpoch });
    this.adapter.cancel(producer.handle);
    this.handles.delete(producer.handle);
    producer.handle = handle;
    producer.periodMs = periodMs;
    producer.lastSequence = 0;
    this.handles.set(handle, producer);
  }

  private instances(schema: CapabilitySchema<unknown>): { id: string; isDefault: boolean; source: string }[] {
    return (this.descriptors.get(schema.id) ?? []).map((entry) => ({ id: entry.instanceId, isDefault: entry.isDefault, source: entry.source }));
  }

  private selectedInstance(schema: CapabilitySchema<unknown>, options: CapabilityObserveOptions): string | undefined {
    const selection = selectCapabilityInstance(this.instances(schema), options.instanceId);
    return selection.status === "selected" ? selection.instance.id : undefined;
  }

  private asState<T>(reading: Reading): CapabilityState<T> {
    if (reading.status === "ready" || reading.status === "stale") {
      return { status: reading.status, value: reading.value as T, observedAtMs: reading.observedAtMs, sequence: reading.sequence, droppedSincePrevious: reading.droppedSincePrevious };
    }
    return { status: reading.status, issue: reading.issue!, ...(reading.value === undefined ? {} : { last: { value: reading.value as T, observedAtMs: reading.observedAtMs, sequence: reading.sequence, droppedSincePrevious: reading.droppedSincePrevious } }) };
  }

  private rejectSubscription<T>(schema: CapabilitySchema<T>, instances: readonly { id: string; isDefault: boolean; source: string }[], onState: (binding: CapabilityBinding<T>) => void, diagnosticId: string): CapabilitySubscription {
    this.reject(diagnosticId);
    onState({ state: { status: "unavailable", issue: issue("busy", "automatic", diagnosticId) }, instances });
    return { cancel: () => undefined };
  }

  private reject(diagnosticId: string): void {
    this.dropped += 1;
    this.lastIssue = issue("protocol-error", "never", diagnosticId);
  }
}

export function createDefaultBoardDescriptors(): readonly NativeCapabilityDescriptor[] {
  return Object.freeze([{
    familyCode: 0x0101,
    semanticId: motionSchema.id,
    instanceId: "motion",
    version: 1,
    source: "qmi8658",
    isDefault: true,
    delivery: "snapshot",
    defaultPeriodMs: 80,
    minPeriodMs: 20,
    maxPeriodMs: 1000,
    maxFrameBytes: 512,
  }]);
}

function resolveLimits(limits: Partial<BoardRuntimeLimits>): BoardRuntimeLimits {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  for (const value of Object.values(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("board resource limit must be positive");
  }
  return Object.freeze(resolved);
}

function validateDescriptor(descriptor: NativeCapabilityDescriptor): void {
  if (!Number.isSafeInteger(descriptor.familyCode) || descriptor.familyCode <= 0 || !descriptor.semanticId || !descriptor.instanceId || !descriptor.source) {
    throw new Error("capability descriptor identity is invalid");
  }
  if (descriptor.version !== 1 || descriptor.maxFrameBytes < 1 || descriptor.minPeriodMs < 1 || descriptor.defaultPeriodMs < descriptor.minPeriodMs || descriptor.defaultPeriodMs > descriptor.maxPeriodMs) {
    throw new Error("capability descriptor bounds are invalid");
  }
}

function boundPeriod(requested: number, descriptor: NativeCapabilityDescriptor): number {
  if (!Number.isSafeInteger(requested) || requested <= 0) return descriptor.defaultPeriodMs;
  return Math.max(descriptor.minPeriodMs, Math.min(descriptor.maxPeriodMs, requested));
}

function isEpoch(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function isEventValid(event: NativeBoardEvent, producer: Producer): boolean {
  return isCachedEventValid(event, producer.descriptor.maxFrameBytes)
    && event.handle === producer.handle
    && event.reloadEpoch === producer.reloadEpoch;
}
function isCachedEventValid(event: NativeBoardEvent, maxFrameBytes: number): boolean {
  return event.version === 1 && event.kind === "state" && Number.isSafeInteger(event.handle) && Number.isSafeInteger(event.reloadEpoch) && event.reloadEpoch > 0 && Number.isSafeInteger(event.sequence) && event.sequence > 0 && Number.isFinite(event.observedAtMs) && event.payload.length <= maxFrameBytes;
}
function decodeReading(event: NativeBoardEvent, schema: CapabilitySchema<unknown>): Reading | undefined {
  const value = decodeBoardPayload(event.payload);
  if (value === undefined || value.schemaVersion !== schema.version || !isStatus(value.status)) return undefined;
  const dropped = typeof value.droppedSincePrevious === "number" && Number.isSafeInteger(value.droppedSincePrevious) && value.droppedSincePrevious >= 0 ? value.droppedSincePrevious : 0;
  if ((value.status === "ok" || value.status === "stale") && !schema.validate(value.value)) return undefined;
  if (value.status === "ok" || value.status === "stale") {
    return { status: value.status === "ok" ? "ready" : "stale", value: value.value, observedAtMs: event.observedAtMs, sequence: event.sequence, droppedSincePrevious: dropped };
  }
  const rawIssue = value.issue;
  if (typeof rawIssue !== "object" || rawIssue === null) return undefined;
  const candidate = rawIssue as Record<string, unknown>;
  if (!isBoardIssue(candidate.code, candidate.retry, candidate.diagnosticId)) return undefined;
  return { status: value.status, issue: issue(candidate.code, candidate.retry as BoardIssue["retry"], candidate.diagnosticId as string), observedAtMs: event.observedAtMs, sequence: event.sequence, droppedSincePrevious: dropped };
}
function isStatus(value: unknown): value is "ok" | "stale" | "unavailable" | "error" {
  return value === "ok" || value === "stale" || value === "unavailable" || value === "error";
}
