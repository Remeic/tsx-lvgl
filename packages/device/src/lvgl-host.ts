import type { ElementType } from "@tsx-lvgl/core";
import type { RuntimeHost, RuntimeHostInstance } from "@tsx-lvgl/runtime";
import type { NativeLvgl, NativeWidgetKind } from "./native.js";
import { NATIVE_EVENT_CODE } from "./native.js";
import { applyStyleDiff, normalizeStyle, type NormalizedStyle, type StyleTarget } from "./style.js";

/** A dispatched event handler. `value` is absent for value-less events (clicks). */
export type EventHandler = (value: number | undefined) => void;

/**
 * Owns the (id, event) -> handler map. A plain `Map` wrapper rather than a
 * class so `dispatch` can be handed to `native.onEvent` as a bound function
 * reference with no extra allocation.
 */
export interface EventRegistry {
  set(id: number, event: number, handler: EventHandler): void;
  delete(id: number, event: number): void;
  /** Drops every handler for `id`; used on dispose. */
  deleteId(id: number): void;
  dispatch(id: number, event: number, value: number | undefined): void;
}

export function createEventRegistry(): EventRegistry {
  const handlers = new Map<number, Map<number, EventHandler>>();
  return {
    set(id: number, event: number, handler: EventHandler): void {
      let byEvent = handlers.get(id);
      if (byEvent === undefined) {
        byEvent = new Map();
        handlers.set(id, byEvent);
      }
      byEvent.set(event, handler);
    },
    delete(id: number, event: number): void {
      const byEvent = handlers.get(id);
      if (byEvent === undefined) return;
      byEvent.delete(event);
      if (byEvent.size === 0) handlers.delete(id);
    },
    deleteId(id: number): void {
      handlers.delete(id);
    },
    dispatch(id: number, event: number, value: number | undefined): void {
      handlers.get(id)?.get(event)?.(value);
    },
  };
}

interface DeviceInstance extends RuntimeHostInstance {
  readonly type: ElementType;
  readonly id: number;
  style: NormalizedStyle;
}

const EMPTY_STYLE: NormalizedStyle = new Map();

/** Exported for the C-parity gate (tests/runtime-probe-source.test.mjs). */
export const widgetKindByType: Readonly<Record<ElementType, NativeWidgetKind>> = {
  Screen: "screen",
  View: "view",
  Text: "text",
  Button: "button",
};

function textOf(props: Readonly<Record<string, unknown>>): string {
  return String(props.text);
}

function labelOf(props: Readonly<Record<string, unknown>>): string {
  return String(props.label);
}

function styleTargetForElement(type: ElementType): StyleTarget {
  return type === "Text" || type === "Button" ? "text" : "view";
}

function asDevice(instance: RuntimeHostInstance): DeviceInstance {
  return instance as DeviceInstance;
}

/**
 * The LVGL-facing `RuntimeHost` implementation: translates the reconciler's
 * ordered operations into calls on the native ABI (`native.ts`) and keeps
 * `events` in sync with each widget's current event handlers.
 */
export function createLvglHost(native: NativeLvgl, events: EventRegistry): RuntimeHost {
  return {
    createInstance(type: ElementType, props: Readonly<Record<string, unknown>>): RuntimeHostInstance {
      const id = native.create(widgetKindByType[type]);
      if (type === "Text") {
        native.setText(id, textOf(props));
      } else if (type === "Button") {
        native.setText(id, labelOf(props));
        const onClick = props.onClick;
        if (typeof onClick === "function") {
          events.set(id, NATIVE_EVENT_CODE.clicked, onClick as EventHandler);
          native.setListening(id, NATIVE_EVENT_CODE.clicked, true);
        }
      }
      const style = normalizeStyle(props.style, styleTargetForElement(type));
      applyStyleDiff(native, id, EMPTY_STYLE, style);
      const instance: DeviceInstance = { type, id, style };
      return instance;
    },

    insertChild(parent: RuntimeHostInstance | null, child: RuntimeHostInstance, index: number): void {
      if (parent === null) return;
      native.insert(asDevice(parent).id, asDevice(child).id, index);
    },

    updateInstance(
      instance: RuntimeHostInstance,
      type: ElementType,
      previousProps: Readonly<Record<string, unknown>>,
      nextProps: Readonly<Record<string, unknown>>,
    ): void {
      const device = asDevice(instance);
      const id = device.id;

      const nextStyle = normalizeStyle(nextProps.style, styleTargetForElement(device.type));
      applyStyleDiff(native, id, device.style, nextStyle);
      device.style = nextStyle;

      if (type === "Text") {
        const next = textOf(nextProps);
        if (next !== textOf(previousProps)) native.setText(id, next);
        return;
      }
      if (type !== "Button") return;

      const nextLabel = labelOf(nextProps);
      if (nextLabel !== labelOf(previousProps)) native.setText(id, nextLabel);

      const previousOnClick = previousProps.onClick;
      const nextOnClick = nextProps.onClick;
      if (typeof nextOnClick === "function") {
        events.set(id, NATIVE_EVENT_CODE.clicked, nextOnClick as EventHandler);
        if (typeof previousOnClick !== "function") native.setListening(id, NATIVE_EVENT_CODE.clicked, true);
      } else if (typeof previousOnClick === "function") {
        events.delete(id, NATIVE_EVENT_CODE.clicked);
        native.setListening(id, NATIVE_EVENT_CODE.clicked, false);
      }
    },

    removeChild(parent: RuntimeHostInstance | null, child: RuntimeHostInstance): void {
      if (parent === null) return;
      native.remove(asDevice(parent).id, asDevice(child).id);
    },

    dispose(instance: RuntimeHostInstance): void {
      const id = asDevice(instance).id;
      events.deleteId(id);
      native.dispose(id);
    },

    replaceRoot(next: RuntimeHostInstance | null, _previous: RuntimeHostInstance | null): void {
      native.loadScreen(next === null ? 0 : asDevice(next).id);
    },
  };
}
