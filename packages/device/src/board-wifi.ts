import { issue, type BoardIssue, type CapabilityState, type OperationId, type OperationState } from "@tsx-lvgl/capabilities";
import {
  WIFI_MAX_PENDING_COMMANDS,
  WIFI_MAX_TERMINAL_HISTORY,
  isWifiStationTelemetry,
  validateWifiScanRequest,
  type ConnectivityContext,
  type WifiDiagnostics,
  type WifiLink,
  type WifiNetwork,
  type WifiOperation,
  type WifiScanRequest,
  type WifiService,
} from "@tsx-lvgl/connectivity";
import { decodeBoardPayload } from "./board-adapter.js";
import type { BoardPlatformAdapter, NativeBoardEvent } from "./native.js";

const WIFI_INSTANCE_ID = "wifi.station";

interface RecordState<T> {
  readonly id: OperationId;
  readonly handle: number;
  readonly commandId: "scan" | "connect" | "disconnect";
  readonly context: ConnectivityContext;
  readonly createdAtMs: number;
  readonly listeners: Set<(state: OperationState<T>) => void>;
  state: OperationState<T>;
}

export interface NativeBoardWifiOptions {
  /** Injectable clock keeps deadline conformance deterministic on host and QuickJS. */
  readonly now?: () => number;
  readonly commandTimeoutMs?: number;
}

class NativeOperation<T> implements WifiOperation<T> {
  public constructor(private readonly record: RecordState<T>, private readonly cancelOperation: () => void) {}
  public get id(): OperationId { return this.record.id; }
  public cancel(): void { this.cancelOperation(); }
  public subscribe(listener: (state: OperationState<T>) => void): () => void {
    listener(this.record.state);
    if (this.record.state.status !== "running") return () => undefined;
    this.record.listeners.add(listener);
    return () => this.record.listeners.delete(listener);
  }
  public finish(state: OperationState<T>): void {
    if (this.record.state.status !== "running") return;
    this.record.state = state;
    for (const listener of [...this.record.listeners]) listener(state);
    this.record.listeners.clear();
  }
}

/**
 * Wi-Fi command transport layered on the existing board adapter. Credential
 * bytes never cross this boundary: the ESP-IDF provider reads only local
 * build configuration and replies through the same owner queue as motion.
 */
export class NativeBoardWifiService implements WifiService {
  private readonly operations = new Map<number, NativeOperation<any>>();
  private readonly records = new Map<number, RecordState<any>>();
  private readonly listeners = new Set<(state: CapabilityState<WifiLink>) => void>();
  private state: CapabilityState<WifiLink>;
  private nextId = 1;
  private highWater = 0;
  private terminalHistory = 0;
  private lastIssue: BoardIssue | undefined;
  private disposed = false;
  private readonly now: () => number;
  private readonly commandTimeoutMs: number;

  public constructor(private readonly adapter: BoardPlatformAdapter, options: NativeBoardWifiOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.commandTimeoutMs = options.commandTimeoutMs ?? 16_000;
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) throw new Error("Wi-Fi command timeout must be a positive integer");
    this.state = decodeWifiState(adapter.readCached(WIFI_INSTANCE_ID)) ?? ready({ phase: "disabled" });
  }

  public getState(): CapabilityState<WifiLink> { return this.state; }
  public subscribe(listener: (state: CapabilityState<WifiLink>) => void, context: ConnectivityContext): () => void {
    if (this.disposed || context.isCancelled()) return () => undefined;
    listener(this.state);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public scan(request: WifiScanRequest, context: ConnectivityContext): WifiOperation<readonly WifiNetwork[]> {
    if (!validateWifiScanRequest(request)) return this.reject("invalid-input", "wifi-scan-request");
    return this.start<readonly WifiNetwork[]>("scan", context);
  }
  public connect(context: ConnectivityContext): WifiOperation<void> { return this.start<void>("connect", context); }
  public disconnect(context: ConnectivityContext): WifiOperation<void> { return this.start<void>("disconnect", context); }
  public diagnostics(): WifiDiagnostics {
    return Object.freeze({ pendingCommands: this.pending(), queueHighWater: this.highWater, terminalHistory: Math.min(this.terminalHistory, WIFI_MAX_TERMINAL_HISTORY), ...(this.lastIssue === undefined ? {} : { lastIssue: this.lastIssue }) });
  }
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const operation of [...this.operations.values()]) this.cancel(operation);
    this.listeners.clear();
  }
  /** Called from every kernel pump, so a lost native event cannot strand an operation. */
  public expire(): void {
    for (const record of [...this.records.values()]) {
      if (record.context.isCancelled()) {
        const operation = this.operations.get(record.handle);
        if (operation !== undefined) this.cancel(operation);
        continue;
      }
      if (this.now() - record.createdAtMs < this.commandTimeoutMs) continue;
      this.adapter.cancel(record.handle);
      this.finish(record, { status: "failed", id: record.id, issue: issue("timeout", "manual", "wifi-command-timeout") });
    }
  }
  /** Called only by BoardRuntime's single adapter sink. */
  public accept(event: NativeBoardEvent): boolean {
    if (event.instanceId !== WIFI_INSTANCE_ID) return false;
    if (event.kind === "state") {
      const state = decodeWifiState(event);
      if (state === undefined) return false;
      this.setState(state);
      return true;
    }
    const record = this.records.get(event.handle);
    if (record === undefined || record.context.reloadEpoch !== event.reloadEpoch || record.context.isCancelled()) {
      const operation = record === undefined ? undefined : this.operations.get(event.handle);
      if (operation !== undefined) this.cancel(operation);
      return true;
    }
    const payload = decodeBoardPayload(event.payload);
    if (payload === undefined || payload.correlationId !== String(record.id)) return false;
    if (payload.status === "succeeded") {
      this.finish(record, { status: "succeeded", id: record.id, value: record.commandId === "scan" ? Object.freeze([]) : undefined });
      return true;
    }
    const rawIssue = payload.issue;
    if (payload.status !== "failed" || !validIssue(rawIssue)) return false;
    this.finish(record, { status: "failed", id: record.id, issue: issue(rawIssue.code, rawIssue.retry, rawIssue.diagnosticId) });
    return true;
  }

  private start<T>(commandId: "scan" | "connect" | "disconnect", context: ConnectivityContext): WifiOperation<T> {
    if (this.disposed || context.isCancelled()) return this.reject("cancelled", "wifi-command-cancelled");
    if (this.pending() >= WIFI_MAX_PENDING_COMMANDS) return this.reject("resource-exhausted", "wifi-command-capacity");
    const id = this.nextId++ as OperationId;
    let handle: number;
    try {
      handle = this.adapter.submit({ version: 1, kind: "command", instanceId: WIFI_INSTANCE_ID, commandId, correlationId: String(id), reloadEpoch: context.reloadEpoch });
    } catch (error) {
      return this.reject(isQueueFull(error) ? "resource-exhausted" : "hardware-failure", isQueueFull(error) ? "wifi-command-queue-full" : "wifi-command-submit");
    }
    const record: RecordState<T> = { id, handle, commandId, context, createdAtMs: this.now(), state: { status: "running", id }, listeners: new Set() };
    const operation = new NativeOperation(record, () => this.cancel(operation));
    this.records.set(handle, record as RecordState<any>);
    this.operations.set(handle, operation as NativeOperation<any>);
    this.highWater = Math.max(this.highWater, this.pending());
    return operation;
  }
  private reject<T>(code: BoardIssue["code"], diagnosticId: string): WifiOperation<T> {
    const id = this.nextId++ as OperationId;
    const nextIssue = issue(code, code === "timeout" ? "manual" : "never", diagnosticId);
    const state: OperationState<T> = { status: "failed", id, issue: nextIssue };
    this.terminalHistory += 1;
    this.lastIssue = nextIssue;
    return { id, cancel: () => undefined, subscribe(listener) { listener(state); return () => undefined; } };
  }
  private cancel(operation: NativeOperation<any>): void {
    const handle = [...this.operations.entries()].find(([, candidate]) => candidate === operation)?.[0];
    if (handle === undefined) return;
    const record = this.records.get(handle)!;
    this.adapter.cancel(record.handle);
    this.finish(record, { status: "failed", id: record.id, issue: issue("cancelled", "never", "wifi-command-cancelled") });
  }
  private finish(record: RecordState<any>, state: OperationState<any>): void {
    const operation = this.operations.get(record.handle);
    operation?.finish(state);
    this.operations.delete(record.handle);
    this.records.delete(record.handle);
    this.terminalHistory += 1;
    if (state.status === "failed") this.lastIssue = state.issue;
  }
  private pending(): number { return this.operations.size; }
  private setState(state: CapabilityState<WifiLink>): void { this.state = state; for (const listener of [...this.listeners]) listener(state); }
}

function decodeWifiState(event: NativeBoardEvent | undefined): CapabilityState<WifiLink> | undefined {
  if (event === undefined || event.kind !== "state" || event.instanceId !== WIFI_INSTANCE_ID) return undefined;
  const payload = decodeBoardPayload(event.payload);
  if (payload === undefined || payload.status !== "ok" || typeof payload.value !== "object" || payload.value === null) return undefined;
  const value = payload.value as Record<string, unknown>;
  if (value.phase === "disabled" || value.phase === "idle" || value.phase === "connecting") return ready({ phase: value.phase });
  if (value.phase === "connected" && isWifiStationTelemetry(value.station)) return ready({ phase: "connected", station: Object.freeze({ ...value.station }) });
  return undefined;
}
function validIssue(value: unknown): value is { code: BoardIssue["code"]; retry: BoardIssue["retry"]; diagnosticId: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  try { issue(candidate.code as BoardIssue["code"], candidate.retry as BoardIssue["retry"], candidate.diagnosticId as string); return true; } catch { return false; }
}
function ready<T>(value: T): CapabilityState<T> { return Object.freeze({ status: "ready" as const, value, observedAtMs: 0, sequence: 0, droppedSincePrevious: 0 }); }
function isQueueFull(error: unknown): boolean { return error instanceof Error && error.message === "board.submit: wifi-command-queue-full"; }
