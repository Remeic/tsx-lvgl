import { issue, type BoardIssue, type CapabilityState, type OperationId, type OperationState } from "@tsx-lvgl/capabilities";

export type { BoardIssue, CapabilityState, OperationId, OperationState } from "@tsx-lvgl/capabilities";

export interface ConnectivityContext {
  readonly reloadEpoch: number;
  isCancelled(): boolean;
}

export type WifiAuthKind = "open" | "wep" | "wpa" | "wpa2" | "wpa3" | "unknown";

/** Sanitised station telemetry: no network identity or address is retained in state. */
export interface WifiStationTelemetry {
  readonly rssiDbm: number;
  readonly channel: number;
  readonly authKind: WifiAuthKind;
}

/** State is observable, but this does not grant applications network APIs. */
export type WifiLink =
  | { readonly phase: "disabled" | "idle" }
  | { readonly phase: "connecting" }
  | { readonly phase: "connected"; readonly station: WifiStationTelemetry };

export interface WifiNetwork {
  /** Boot-scoped opaque identity; it is deliberately not a BSSID. */
  readonly id: string;
  readonly ssid: string;
  readonly rssiDbm: number;
  readonly channel: number;
  readonly authKind: WifiAuthKind;
}

export interface WifiScanRequest {
  readonly maxResults?: number;
  readonly active?: boolean;
}

/** The passphrase is used only to submit this command and is never retained. */
export interface EphemeralWifiConnectRequest {
  readonly ssid: string;
  readonly passphrase: string;
}

export interface WifiOperation<T> {
  readonly id: OperationId;
  cancel(): void;
  subscribe(listener: (state: OperationState<T>) => void): () => void;
}

export interface WifiService {
  getState(): CapabilityState<WifiLink>;
  subscribe(listener: (state: CapabilityState<WifiLink>) => void, context: ConnectivityContext): () => void;
  scan(request: WifiScanRequest, context: ConnectivityContext): WifiOperation<readonly WifiNetwork[]>;
  connect(request: EphemeralWifiConnectRequest, context: ConnectivityContext): WifiOperation<void>;
  disconnect(context: ConnectivityContext): WifiOperation<void>;
  diagnostics(): WifiDiagnostics;
}

export interface WifiController {
  readonly state: CapabilityState<WifiLink>;
  readonly scan: OperationState<readonly WifiNetwork[]>;
  readonly connection: OperationState<void>;
  scanNetworks(request?: WifiScanRequest): OperationId;
  cancelScan(): void;
  connect(request: EphemeralWifiConnectRequest): OperationId;
  disconnect(): OperationId;
}

/** Bounded operator data. It intentionally excludes SSIDs, IPs, operation IDs and secrets. */
export interface WifiDiagnostics {
  readonly pendingCommands: number;
  readonly queueHighWater: number;
  readonly terminalHistory: number;
  readonly lastIssue?: BoardIssue;
}

export const WIFI_MAX_SCAN_RESULTS = 64;
export const WIFI_MAX_PENDING_COMMANDS = 32;
export const WIFI_MAX_TERMINAL_HISTORY = 32;
export const WIFI_SSID_MAX_BYTES = 32;
export const WIFI_PASSPHRASE_MAX_BYTES = 64;

export function validateWifiScanRequest(value: unknown): value is WifiScanRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  const maxResults = request.maxResults;
  return (maxResults === undefined || (typeof maxResults === "number" && Number.isSafeInteger(maxResults) && maxResults > 0 && maxResults <= WIFI_MAX_SCAN_RESULTS))
    && (request.active === undefined || typeof request.active === "boolean");
}

export function validateEphemeralWifiConnectRequest(value: unknown): value is EphemeralWifiConnectRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return typeof request.ssid === "string" && byteLength(request.ssid) > 0 && byteLength(request.ssid) <= WIFI_SSID_MAX_BYTES
    && typeof request.passphrase === "string" && byteLength(request.passphrase) <= WIFI_PASSPHRASE_MAX_BYTES;
}

export function redactWifiConnectRequest(_request: EphemeralWifiConnectRequest): { readonly ssid: "<redacted>"; readonly passphrase: "<redacted>" } {
  return Object.freeze({ ssid: "<redacted>" as const, passphrase: "<redacted>" as const });
}

export function isWifiNetwork(value: unknown): value is WifiNetwork {
  if (typeof value !== "object" || value === null) return false;
  const network = value as Record<string, unknown>;
  return isText(network.id) && isText(network.ssid) && isRssi(network.rssiDbm) && isChannel(network.channel) && isAuthKind(network.authKind);
}

export function isWifiStationTelemetry(value: unknown): value is WifiStationTelemetry {
  if (typeof value !== "object" || value === null) return false;
  const network = value as Record<string, unknown>;
  return isRssi(network.rssiDbm) && isChannel(network.channel) && isAuthKind(network.authKind);
}

interface RecordState<T> {
  readonly id: OperationId;
  readonly context: ConnectivityContext;
  state: OperationState<T>;
  readonly listeners: Set<(state: OperationState<T>) => void>;
}

class MemoryOperation<T> implements WifiOperation<T> {
  public constructor(private readonly record: RecordState<T>, private readonly cancelOperation: () => void) {}
  public get id(): OperationId { return this.record.id; }
  public cancel(): void { this.cancelOperation(); }
  public subscribe(listener: (state: OperationState<T>) => void): () => void {
    listener(this.record.state);
    if (this.record.state.status !== "running") return () => undefined;
    this.record.listeners.add(listener);
    return () => this.record.listeners.delete(listener);
  }
  public state(): OperationState<T> { return this.record.state; }
  public isCancelled(): boolean { return this.record.context.isCancelled(); }
  public finish(state: OperationState<T>): void {
    if (this.record.state.status !== "running") return;
    this.record.state = state;
    for (const listener of [...this.record.listeners]) listener(state);
    this.record.listeners.clear();
  }
}

export interface MemoryWifiOptions {
  readonly now?: () => number;
  readonly scanTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly disconnectTimeoutMs?: number;
}

/**
 * Deterministic Wi-Fi station conformance adapter. The test host explicitly
 * completes native-like work, while `expire()` handles deadlines without timers.
 */
export class MemoryWifiService implements WifiService {
  private readonly operations = new Map<number, MemoryOperation<any>>();
  private readonly createdAt = new Map<number, number>();
  private readonly stateListeners = new Set<(state: CapabilityState<WifiLink>) => void>();
  private readonly now: () => number;
  private readonly timeouts: Required<Omit<MemoryWifiOptions, "now">>;
  private state: CapabilityState<WifiLink> = ready({ phase: "idle" });
  private scanOperation: MemoryOperation<readonly WifiNetwork[]> | undefined;
  private connection: MemoryOperation<void> | undefined;
  private nextId = 1;
  private highWater = 0;
  private terminalHistory = 0;
  private lastIssue: BoardIssue | undefined;
  private disposed = false;

  public constructor(options: MemoryWifiOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.timeouts = {
      scanTimeoutMs: options.scanTimeoutMs ?? 10_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
      disconnectTimeoutMs: options.disconnectTimeoutMs ?? 5_000,
    };
    for (const timeout of Object.values(this.timeouts)) if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("Wi-Fi timeout must be a positive integer");
  }

  public getState(): CapabilityState<WifiLink> { return this.state; }

  public subscribe(listener: (state: CapabilityState<WifiLink>) => void, context: ConnectivityContext): () => void {
    if (this.disposed || context.isCancelled()) return () => undefined;
    listener(this.state);
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public scan(request: WifiScanRequest, context: ConnectivityContext): WifiOperation<readonly WifiNetwork[]> {
    if (!validateWifiScanRequest(request)) return this.reject("invalid-input", "wifi-scan-request");
    if (this.scanOperation?.state().status === "running") return this.reject("busy", "wifi-scan-busy");
    const operation = this.start<readonly WifiNetwork[]>(context);
    if (operation.state().status === "running") this.scanOperation = operation;
    return operation;
  }

  public connect(request: EphemeralWifiConnectRequest, context: ConnectivityContext): WifiOperation<void> {
    if (!validateEphemeralWifiConnectRequest(request)) return this.reject("invalid-input", "wifi-connect-request");
    if (this.connection?.state().status === "running") return this.reject("busy", "wifi-connect-busy");
    const operation = this.start<void>(context);
    if (operation.state().status === "running") {
      this.connection = operation;
      this.setState({ phase: "connecting" });
    }
    return operation;
  }

  public disconnect(context: ConnectivityContext): WifiOperation<void> {
    if (this.connection?.state().status === "running") return this.reject("busy", "wifi-disconnect-busy");
    const operation = this.start<void>(context);
    if (operation.state().status === "running") this.connection = operation;
    return operation;
  }

  public completeScan(id: OperationId, networks: readonly WifiNetwork[]): void {
    const operation = this.operation<readonly WifiNetwork[]>(id);
    if (operation === undefined || operation !== this.scanOperation || !this.isActive(operation)) return;
    const unique = new Map<string, WifiNetwork>();
    for (const network of networks) if (isWifiNetwork(network) && !unique.has(network.id)) unique.set(network.id, Object.freeze({ ...network }));
    this.succeed(operation, Object.freeze([...unique.values()].sort((a, b) => b.rssiDbm - a.rssiDbm || a.id.localeCompare(b.id)).slice(0, WIFI_MAX_SCAN_RESULTS)));
    this.scanOperation = undefined;
  }

  public completeConnect(id: OperationId, station: WifiStationTelemetry): void {
    const operation = this.operation<void>(id);
    if (operation === undefined || operation !== this.connection || !this.isActive(operation)) return;
    if (!isWifiStationTelemetry(station)) return this.fail(operation, "protocol-error", "wifi-connect-result");
    this.setState({ phase: "connected", station: Object.freeze({ ...station }) });
    this.succeed(operation, undefined);
    this.connection = undefined;
  }

  public completeDisconnect(id: OperationId): void {
    const operation = this.operation<void>(id);
    if (operation === undefined || operation !== this.connection || !this.isActive(operation)) return;
    this.setState({ phase: "idle" });
    this.succeed(operation, undefined);
    this.connection = undefined;
  }

  /** Test/native adapter inspection; terminal data remains bounded to 32 commands. */
  public getOperation<T>(id: OperationId): OperationState<T> {
    return this.operations.get(id as number)?.state() as OperationState<T> | undefined ?? { status: "idle" };
  }

  /** Call from the native/task clock; all deadlines and cancellation are deterministic. */
  public expire(): void {
    for (const operation of [...this.operations.values()]) {
      if (!this.isActive(operation)) continue;
      const age = this.now() - (this.createdAt.get(operation.id as number) ?? this.now());
      const timeout = operation === this.scanOperation ? this.timeouts.scanTimeoutMs
        : this.state.status === "ready" && this.state.value.phase === "connecting" ? this.timeouts.connectTimeoutMs
          : this.timeouts.disconnectTimeoutMs;
      if (age >= timeout) this.fail(operation, "timeout", "wifi-command-timeout");
    }
  }

  public diagnostics(): WifiDiagnostics {
    return Object.freeze({ pendingCommands: this.pending(), queueHighWater: this.highWater, terminalHistory: Math.min(this.terminalHistory, WIFI_MAX_TERMINAL_HISTORY), ...(this.lastIssue === undefined ? {} : { lastIssue: this.lastIssue }) });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const operation of this.operations.values()) if (operation.state().status === "running") this.fail(operation, "cancelled", "wifi-disposed");
    this.stateListeners.clear();
  }

  private start<T>(context: ConnectivityContext): MemoryOperation<T> {
    if (this.disposed || context.isCancelled()) return this.reject("cancelled", "wifi-command-cancelled") as MemoryOperation<T>;
    if (this.pending() >= WIFI_MAX_PENDING_COMMANDS) return this.reject("resource-exhausted", "wifi-command-capacity") as MemoryOperation<T>;
    const id = this.nextId++ as OperationId;
    const record: RecordState<T> = { id, context, state: { status: "running", id }, listeners: new Set() };
    const operation = new MemoryOperation(record, () => this.cancel(operation));
    this.operations.set(id as number, operation as MemoryOperation<any>);
    this.createdAt.set(id as number, this.now());
    this.highWater = Math.max(this.highWater, this.pending());
    this.trimHistory();
    return operation;
  }

  private reject<T>(code: BoardIssue["code"], diagnosticId: string): MemoryOperation<T> {
    const id = this.nextId++ as OperationId;
    const record: RecordState<T> = { id, context: { reloadEpoch: 0, isCancelled: () => true }, state: { status: "running", id }, listeners: new Set() };
    const operation = new MemoryOperation(record, () => undefined);
    this.fail(operation, code, diagnosticId);
    return operation;
  }

  private cancel(operation: MemoryOperation<any>): void {
    if (!this.isActive(operation)) return;
    this.fail(operation, "cancelled", "wifi-command-cancelled");
  }

  private isActive(operation: MemoryOperation<any>): boolean {
    if (operation.state().status !== "running") return false;
    if (operation.isCancelled()) {
      this.fail(operation, "cancelled", "wifi-command-epoch");
      return false;
    }
    return true;
  }

  private succeed<T>(operation: MemoryOperation<T>, value: T): void {
    const state = operation.state();
    if (state.status !== "running") return;
    operation.finish({ status: "succeeded", id: state.id, value });
    this.terminalHistory += 1;
  }

  private fail(operation: MemoryOperation<any>, code: BoardIssue["code"], diagnosticId: string): void {
    const state = operation.state();
    if (state.status !== "running") return;
    const nextIssue = issue(code, code === "timeout" ? "manual" : "never", diagnosticId);
    operation.finish({ status: "failed", id: state.id, issue: nextIssue });
    this.lastIssue = nextIssue;
    this.terminalHistory += 1;
    if (operation === this.scanOperation) this.scanOperation = undefined;
    if (operation === this.connection) {
      this.connection = undefined;
      if (this.state.status === "ready" && this.state.value.phase === "connecting") this.setState({ phase: "idle" });
    }
  }

  private operation<T>(id: OperationId): MemoryOperation<T> | undefined { return this.operations.get(id as number) as MemoryOperation<T> | undefined; }
  private pending(): number { let count = 0; for (const operation of this.operations.values()) if (operation.state().status === "running") count += 1; return count; }
  private setState(link: WifiLink): void { this.state = ready(link); for (const listener of [...this.stateListeners]) listener(this.state); }
  private trimHistory(): void {
    while (this.operations.size > WIFI_MAX_TERMINAL_HISTORY) {
      const completed = [...this.operations.entries()].find(([, operation]) => operation.state().status !== "running");
      if (completed === undefined) return;
      this.operations.delete(completed[0]); this.createdAt.delete(completed[0]);
    }
  }
}

function ready<T>(value: T): CapabilityState<T> { return Object.freeze({ status: "ready" as const, value, observedAtMs: 0, sequence: 0, droppedSincePrevious: 0 }); }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function isText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 96 && !value.includes("\0"); }
function isRssi(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= -127 && value <= 0; }
function isChannel(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 196; }
function isAuthKind(value: unknown): value is WifiAuthKind { return value === "open" || value === "wep" || value === "wpa" || value === "wpa2" || value === "wpa3" || value === "unknown"; }
