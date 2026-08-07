import type { ElementType } from "@tsx-lvgl/core";
import type { RuntimeHost, RuntimeHostInstance } from "@tsx-lvgl/runtime";
import type { NativeLvgl, NativeWidgetKind } from "./native.js";

/**
 * Owns the id -> click handler map. A plain `Map` wrapper rather than a
 * class so `dispatch` can be handed to `native.onClick` as a bound function
 * reference with no extra allocation.
 */
export interface ClickRegistry {
  set(id: number, handler: () => void): void;
  delete(id: number): void;
  dispatch(id: number): void;
}

export function createClickRegistry(): ClickRegistry {
  const handlers = new Map<number, () => void>();
  return {
    set(id: number, handler: () => void): void {
      handlers.set(id, handler);
    },
    delete(id: number): void {
      handlers.delete(id);
    },
    dispatch(id: number): void {
      handlers.get(id)?.();
    },
  };
}

interface DeviceInstance extends RuntimeHostInstance {
  readonly type: ElementType;
  readonly id: number;
}

const widgetKindByType: Readonly<Record<ElementType, NativeWidgetKind>> = {
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

function asDevice(instance: RuntimeHostInstance): DeviceInstance {
  return instance as DeviceInstance;
}

/**
 * The LVGL-facing `RuntimeHost` implementation: translates the reconciler's
 * ordered operations into calls on the native ABI (`native.ts`) and keeps
 * `clicks` in sync with each Button's current `onClick` handler.
 */
export function createLvglHost(native: NativeLvgl, clicks: ClickRegistry): RuntimeHost {
  return {
    createInstance(type: ElementType, props: Readonly<Record<string, unknown>>): RuntimeHostInstance {
      const id = native.create(widgetKindByType[type]);
      if (type === "Text") {
        native.setText(id, textOf(props));
      } else if (type === "Button") {
        native.setText(id, labelOf(props));
        const onClick = props.onClick;
        if (typeof onClick === "function") {
          clicks.set(id, onClick as () => void);
          native.setClickable(id, true);
        }
      }
      const instance: DeviceInstance = { type, id };
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
      const id = asDevice(instance).id;
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
        clicks.set(id, nextOnClick as () => void);
        if (typeof previousOnClick !== "function") native.setClickable(id, true);
      } else if (typeof previousOnClick === "function") {
        clicks.delete(id);
        native.setClickable(id, false);
      }
    },

    removeChild(parent: RuntimeHostInstance | null, child: RuntimeHostInstance): void {
      if (parent === null) return;
      native.remove(asDevice(parent).id, asDevice(child).id);
    },

    dispose(instance: RuntimeHostInstance): void {
      const id = asDevice(instance).id;
      clicks.delete(id);
      native.dispose(id);
    },

    replaceRoot(next: RuntimeHostInstance | null, _previous: RuntimeHostInstance | null): void {
      native.loadScreen(next === null ? 0 : asDevice(next).id);
    },
  };
}
