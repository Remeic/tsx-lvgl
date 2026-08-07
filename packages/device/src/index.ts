export type {
  NativeBindings,
  NativeLvgl,
  NativeSensors,
  NativeTimers,
  NativeWidgetKind,
} from "./native.js";

export { createLvglHost, createClickRegistry, type ClickRegistry } from "./lvgl-host.js";
export { createDeviceScheduler } from "./scheduler.js";
export { createNativeMotionSensor } from "./sensors.js";
export { createKernel, type DeviceKernel } from "./kernel.js";
/** ASCII-only string-to-bytes encoding shared with the generated kernel's boot glue. */
export { encodeAsciiSource } from "./kernel.js";
