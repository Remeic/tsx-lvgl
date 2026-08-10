/**
 * The C ABI boundary. This file is the single source of truth the native
 * (ESP-IDF / LVGL) implementation follows: every method here corresponds to
 * one binding the board firmware exposes into the JavaScript engine. No
 * Node built-ins, no DOM globals — this runs inside QuickJS-NG on device and
 * inside plain Node for tests.
 */

export type NativeWidgetKind = "screen" | "view" | "text" | "button";

export interface NativeLvgl {
  /** Creates a widget of `kind` with no parent yet. Returns an integer handle > 0. */
  create(kind: NativeWidgetKind): number;
  /** Inserts `child` under `parent` at `index`, reordering existing children as needed. */
  insert(parent: number, child: number, index: number): void;
  /** Sets label text: the `Text` body or the `Button` label. */
  setText(id: number, text: string): void;
  /** Toggles whether a widget accepts click input and reports it through `onClick`. */
  setClickable(id: number, clickable: boolean): void;
  /** Detaches `child` from `parent` without destroying it. */
  remove(parent: number, child: number): void;
  /** Recursively deletes `id` and all of its descendants, freeing native memory. */
  dispose(id: number): void;
  /** Loads `id` as the active screen. `0` loads a blank screen (no root). */
  loadScreen(id: number): void;
}

export interface NativeTimers {
  /** Schedules `cb` to run every `periodMs` milliseconds. Returns an opaque handle. */
  setInterval(cb: () => void, periodMs: number): number;
  /** Cancels a handle previously returned by `setInterval`. */
  clearInterval(handle: number): void;
}

export interface NativeSensors {
  /** Synchronous, time-bounded read. The returned shape matches `SensorSample`. */
  read(sensorId: string): unknown;
}

/** Bounded, board-owned transport for capability observations. */
export interface NativeCapabilityDescriptor {
  readonly familyCode: number;
  readonly semanticId: string;
  readonly instanceId: string;
  readonly version: 1;
  readonly source: string;
  readonly isDefault: boolean;
  readonly delivery: "snapshot";
  readonly defaultPeriodMs: number;
  readonly minPeriodMs: number;
  readonly maxPeriodMs: number;
  readonly maxFrameBytes: number;
}
export interface NativeBoardRequest { readonly version: 1; readonly kind: "observe"; readonly instanceId: string; readonly periodMs: number; }
export interface NativeBoardEvent { readonly version: 1; readonly kind: "state"; readonly handle: number; readonly sequence: number; readonly observedAtMs: number; readonly payload: Uint8Array; }
export interface BoardPlatformAdapter {
  list(): readonly NativeCapabilityDescriptor[];
  readCached(instanceId: string): NativeBoardEvent | undefined;
  submit(request: NativeBoardRequest): number;
  cancel(handle: number): void;
  setSink(listener: (event: NativeBoardEvent) => void): void;
  dispose(): void;
}

export interface NativeBindings {
  readonly boardId: string;
  readonly lvgl: NativeLvgl;
  readonly timers: NativeTimers;
  readonly sensors: NativeSensors;
  /** Capability transport is optional while the legacy sensor seam remains supported. */
  readonly board?: BoardPlatformAdapter;
  /** Registers the single click dispatcher. Called exactly once per kernel. */
  onClick(dispatch: (id: number) => void): void;
  /** Board-side diagnostic log sink (single-line messages). */
  log(message: string): void;
}
