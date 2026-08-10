export type CapabilityDelivery = "snapshot" | "event" | "stream" | "command";

export interface CapabilitySchema<T> {
  readonly id: string;
  readonly version: number;
  readonly validate: (value: unknown) => value is T;
}

export interface CapabilityToken<T> {
  readonly familyCode: number;
  readonly semanticId: string;
  readonly version: number;
  readonly delivery: CapabilityDelivery;
  readonly validate: (value: unknown) => value is T;
}

export interface CapabilityInstance { readonly id: string; readonly isDefault: boolean; readonly source: string; }
export interface CapabilityRegistration<T> { readonly token: CapabilityToken<T>; readonly instance: CapabilityInstance; }
export interface CapabilityCatalog {
  list(): readonly CapabilityRegistration<unknown>[];
  get<T>(token: CapabilityToken<T>, instanceId?: string): CapabilityRegistration<T> | undefined;
}

export type CapabilitySelection =
  | { readonly status: "selected"; readonly instance: CapabilityInstance }
  | { readonly status: "ambiguous"; readonly instances: readonly CapabilityInstance[] }
  | { readonly status: "unsupported"; readonly reason: "not-present" | "invalid-instance" };
export interface Observation<T> { readonly value: T; readonly observedAtMs: number; readonly sequence: number; readonly droppedSincePrevious: number; }
export type BoardIssueCode = "unsupported" | "not-ready" | "busy" | "cancelled" | "timeout" | "invalid-input" | "resource-exhausted" | "hardware-failure" | "protocol-error" | "internal";
export type BoardIssueRetry = "automatic" | "manual" | "after-reconfigure" | "never";
export interface BoardIssue { readonly code: BoardIssueCode; readonly retry: BoardIssueRetry; readonly diagnosticId: string; }

/** Opaque, process-local correlation identifier for a command lifecycle. */
export type OperationId = number & { readonly __operationId: never };

/** Commands always enter one terminal state; they never expose a Promise seam. */
export type OperationState<T> =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly id: OperationId }
  | { readonly status: "succeeded"; readonly id: OperationId; readonly value: T }
  | { readonly status: "failed"; readonly id: OperationId; readonly issue: BoardIssue };
export type CapabilityState<T> =
  | { readonly status: "unsupported"; readonly reason: "not-present" | "not-implemented" | "disabled-by-profile" | "invalid-instance" }
  | { readonly status: "ambiguous"; readonly instances: readonly CapabilityInstance[] }
  | { readonly status: "starting" }
  | ({ readonly status: "ready" | "stale" } & Observation<T>)
  | { readonly status: "unavailable" | "error"; readonly issue: BoardIssue; readonly last?: Observation<T> };
export interface CapabilityBinding<T> { readonly state: CapabilityState<T>; readonly instances: readonly CapabilityInstance[]; }
export interface CapabilityContext { readonly reloadEpoch: number; isCancelled(): boolean; }
export interface CapabilitySubscription { cancel(): void; }
export interface CapabilityObserveOptions { readonly enabled?: boolean; readonly periodMs?: number; readonly instanceId?: string; }
export interface CapabilityEvent<T> { readonly semanticId: string; readonly schemaVersion: number; readonly reloadEpoch: number; readonly status: "ok" | "stale" | "unavailable" | "error"; readonly observedAtMs: number; readonly sequence: number; readonly droppedSincePrevious: number; readonly value?: T; readonly issue?: BoardIssue; }
export interface BoardDiagnosticsSnapshot { readonly effectivePeriodsMs: Readonly<Record<string, number>>; readonly queueDepth: number; readonly queueHighWater: number; readonly droppedEvents: number; readonly activeOwners: readonly string[]; readonly resourceUse: Readonly<Record<string, number>>; readonly lastIssue?: BoardIssue; }
export interface CapabilityRuntime {
  getBinding<T>(schema: CapabilitySchema<T>, options?: CapabilityObserveOptions): CapabilityBinding<T>;
  subscribe<T>(schema: CapabilitySchema<T>, options: CapabilityObserveOptions, context: CapabilityContext, onState: (binding: CapabilityBinding<T>) => void, onEvent?: (event: CapabilityEvent<T>) => void): CapabilitySubscription;
  diagnostics(): BoardDiagnosticsSnapshot;
  commitEpoch(epoch: number): void;
  rollbackEpoch(epoch: number): void;
  dispose(): void;
}

export function createCapabilityToken<T>(token: CapabilityToken<T>): CapabilityToken<T> {
  if (!Number.isSafeInteger(token.familyCode) || token.familyCode <= 0 || token.familyCode > 0xffff) throw new Error("capability family code must be a uint16");
  if (!isText(token.semanticId)) throw new Error("capability semantic ID must be non-empty");
  if (!Number.isSafeInteger(token.version) || token.version <= 0) throw new Error("capability version must be a positive integer");
  return Object.freeze({ ...token });
}
export function createCapabilityCatalog(registrations: readonly CapabilityRegistration<unknown>[]): CapabilityCatalog {
  const entries: CapabilityRegistration<unknown>[] = [];
  const keys = new Set<string>(); const defaults = new Set<string>();
  for (const registration of registrations) {
    const token = createCapabilityToken(registration.token); const instance = Object.freeze({ ...registration.instance });
    if (!isText(instance.id) || !isText(instance.source)) throw new Error("capability instance identity must be non-empty");
    const key = `${token.familyCode}:${token.version}:${instance.id}`; if (keys.has(key)) throw new Error(`duplicate capability instance: ${key}`); keys.add(key);
    const defaultKey = `${token.semanticId}@${token.version}`;
    if (instance.isDefault && defaults.has(defaultKey)) throw new Error(`multiple default capability instances: ${defaultKey}`);
    if (instance.isDefault) defaults.add(defaultKey); entries.push(Object.freeze({ token, instance }));
  }
  const frozen = Object.freeze(entries);
  return Object.freeze({ list: () => frozen, get<T>(token: CapabilityToken<T>, instanceId?: string) {
    const matching = frozen.filter((entry) => entry.token.semanticId === token.semanticId && entry.token.version === token.version);
    const selection = selectCapabilityInstance(matching.map((entry) => entry.instance), instanceId);
    return selection.status === "selected" ? matching.find((entry) => entry.instance.id === selection.instance.id) as CapabilityRegistration<T> | undefined : undefined;
  }});
}
export function selectCapabilityInstance(instances: readonly CapabilityInstance[], instanceId?: string): CapabilitySelection {
  if (instances.length === 0) return { status: "unsupported", reason: "not-present" };
  if (instanceId !== undefined) { const instance = instances.find((entry) => entry.id === instanceId); return instance === undefined ? { status: "unsupported", reason: "invalid-instance" } : { status: "selected", instance }; }
  const defaults = instances.filter((instance) => instance.isDefault); return defaults.length === 1 ? { status: "selected", instance: defaults[0]! } : { status: "ambiguous", instances };
}
const ISSUE_CODES: readonly BoardIssueCode[] = ["unsupported", "not-ready", "busy", "cancelled", "timeout", "invalid-input", "resource-exhausted", "hardware-failure", "protocol-error", "internal"];
const ISSUE_RETRIES: readonly BoardIssueRetry[] = ["automatic", "manual", "after-reconfigure", "never"];
const MAX_DIAGNOSTIC_ID_LENGTH = 96;

export function issue(code: BoardIssueCode, retry: BoardIssueRetry, diagnosticId: string): BoardIssue {
  if (!ISSUE_CODES.includes(code) || !ISSUE_RETRIES.includes(retry) || !isDiagnosticId(diagnosticId)) {
    throw new Error("board issue is invalid");
  }
  return Object.freeze({ code, retry, diagnosticId });
}

export function isBoardIssue(code: unknown, retry: unknown, diagnosticId: unknown): code is BoardIssueCode {
  return typeof code === "string" && ISSUE_CODES.includes(code as BoardIssueCode)
    && typeof retry === "string" && ISSUE_RETRIES.includes(retry as BoardIssueRetry)
    && typeof diagnosticId === "string" && isDiagnosticId(diagnosticId);
}

function isDiagnosticId(value: string): boolean { return value.length > 0 && value.length <= MAX_DIAGNOSTIC_ID_LENGTH && /^[a-z0-9-]+$/.test(value); }
function isText(value: string): boolean { return value.length > 0 && !value.includes("\0"); }
