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

export interface NativeBindings {
  readonly boardId: string;
  readonly lvgl: NativeLvgl;
  readonly timers: NativeTimers;
  readonly sensors: NativeSensors;
  /** Registers the single click dispatcher. Called exactly once per kernel. */
  onClick(dispatch: (id: number) => void): void;
  /** Board-side diagnostic log sink (single-line messages). */
  log(message: string): void;
}
