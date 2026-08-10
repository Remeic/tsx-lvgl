export type {
  NativeBindings,
  NativeLvgl,
  NativeSensors,
  BoardPlatformAdapter,
  NativeCapabilityDescriptor,
  NativeBoardEvent,
  NativeBoardRequest,
  NativeTimers,
  NativeWidgetKind,
} from "./native.js";

export { createLvglHost, createClickRegistry, type ClickRegistry } from "./lvgl-host.js";
export { createDeviceScheduler } from "./scheduler.js";
export { createNativeMotionSensor } from "./sensors.js";
export { BoardRuntime, createDefaultBoardDescriptors } from "./board-runtime.js";
export { NativeBoardWifiService } from "./board-wifi.js";
export { createBoardSchemaRegistry, DEFAULT_BOARD_SCHEMA_REGISTRY, type BoardSchemaRegistry } from "./board-schema-registry.js";
export { MemoryBoardAdapter, decodeBoardPayload, encodeBoardPayload } from "./board-adapter.js";
export { createKernel, type DeviceKernel } from "./kernel.js";
/** ASCII-only string-to-bytes encoding shared with the generated kernel's boot glue. */
export { encodeAsciiSource } from "./kernel.js";
