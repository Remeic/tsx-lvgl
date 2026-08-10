import * as coreModule from "@tsx-lvgl/core";
import * as jsxRuntimeModule from "@tsx-lvgl/core/jsx-runtime";
import {
  Button,
  Fragment,
  Screen,
  Text,
  View,
  createApplicationFacade,
} from "@tsx-lvgl/core";
import {
  PROTOCOL_VERSION,
  RUNTIME_BUNDLE_MAX_BYTES,
  Runtime,
  createProgramEngine,
  validateRuntimeBundle,
  type ModuleResolver,
  type RuntimeBundle,
  type RuntimeBundleManifest,
  type RuntimeBundlePolicy,
} from "@tsx-lvgl/runtime";
import * as runtimeModule from "@tsx-lvgl/runtime";
import {
  useEffect,
  useInterval,
  useMotion,
  useState,
} from "@tsx-lvgl/runtime";
import { createSensorRegistry, type DeviceCapabilities } from "@tsx-lvgl/sensors";
import * as sensorsModule from "@tsx-lvgl/sensors";
import { isShake } from "@tsx-lvgl/sensors";
import * as capabilitiesModule from "@tsx-lvgl/capabilities";
import { BoardRuntime } from "./board-runtime.js";
import { createClickRegistry, createLvglHost } from "./lvgl-host.js";
import { createDeviceScheduler } from "./scheduler.js";
import { createNativeMotionSensor } from "./sensors.js";
import type { NativeBindings } from "./native.js";

export interface DeviceKernel {
  /** Mounts the initial baked-in app (generation N). Throws on invalid bundle or mount failure. */
  start(bundle: RuntimeBundle): void;
  /** Stages a hot reload. Returns `"committed <epoch>"`, `"rejected <reason>"`, or `"rolled_back"`. */
  stageReload(manifestJson: string, source: string): string;
  /** Drains the scheduler's FIFO of one pump cycle's worth of pending work. */
  pump(): void;
  lastGeneration(): number;
  dispose(): void;
}

const MALFORMED_MANIFEST = Symbol("malformed-manifest");
type ManifestParseResult = RuntimeBundleManifest | typeof MALFORMED_MANIFEST;

function parseManifestJson(manifestJson: string): ManifestParseResult {
  try {
    return JSON.parse(manifestJson) as RuntimeBundleManifest;
  } catch {
    return MALFORMED_MANIFEST;
  }
}

function resolveModule(specifier: string): Record<string, unknown> {
  switch (specifier) {
    case "@tsx-lvgl/sdk":
      return createApplicationFacade({
        Button,
        Fragment,
        Screen,
        Text,
        View,
        useEffect,
        useInterval,
        useMotion,
        useState,
        isShake,
      }) as Record<string, unknown>;
    case "@tsx-lvgl/sdk/jsx-runtime":
      return jsxRuntimeModule as unknown as Record<string, unknown>;
    case "@tsx-lvgl/core":
      return coreModule as unknown as Record<string, unknown>;
    case "@tsx-lvgl/core/jsx-runtime":
      return jsxRuntimeModule as unknown as Record<string, unknown>;
    case "@tsx-lvgl/runtime":
      return runtimeModule as unknown as Record<string, unknown>;
    case "@tsx-lvgl/sensors":
      return sensorsModule as unknown as Record<string, unknown>;
    case "@tsx-lvgl/capabilities":
      return capabilitiesModule as unknown as Record<string, unknown>;
    default:
      throw new Error(`unknown module: ${specifier}`);
  }
}

/**
 * Encodes a JS string to bytes with no `TextEncoder`: on-device engines don't
 * ship one. Returns `null` (rather than throwing) on the first non-ASCII code
 * unit, since the only caller (`stageReload`) has nothing useful to do with a
 * message beyond the "rejected non-ascii" status it already reports.
 */
export function encodeAsciiSource(text: string): Uint8Array | null {
  // Stryker disable next-line ArrayDeclaration: preallocated length is a pure perf hint; every index 0..length-1 is assigned below, so a dynamically-grown array ends up byte-identical
  const codes: number[] = new Array(text.length);
  // Stryker disable next-line UpdateOperator: decrementing this bounded scan never terminates; the increment is the only valid traversal.
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0x80) return null;
    codes[index] = code;
  }
  return Uint8Array.from(codes);
}

/**
 * Wires the LVGL host, scheduler, and sensor registry into a `Runtime`, and
 * exposes the narrow surface the native shell drives: an initial `start`,
 * staged hot reloads via `stageReload`, and a `pump` the native event loop
 * calls once per tick to drain queued re-renders and timer callbacks.
 */
export function createKernel(native: NativeBindings): DeviceKernel {
  const clicks = createClickRegistry();
  const host = createLvglHost(native.lvgl, clicks);
  const scheduler = createDeviceScheduler(native.timers);
  const capabilities: DeviceCapabilities = {
    sensors: createSensorRegistry([createNativeMotionSensor(native.sensors, native.timers)]),
  };
  const board = native.board === undefined ? undefined : new BoardRuntime(native.board);
  const runtime = new Runtime({
    host,
    scheduler,
    capabilities,
    ...(board === undefined ? {} : { board }),
    onError: (error: unknown) => native.log(`kernel: error ${String(error)}`),
  });
  native.onClick(clicks.dispatch);

  const resolve: ModuleResolver = resolveModule;
  const engine = createProgramEngine("quickjs-ng", resolve);

  let lastGeneration = 0;

  function policy(): RuntimeBundlePolicy {
    return {
      protocolVersion: PROTOCOL_VERSION,
      engine: "quickjs-ng",
      boardId: native.boardId,
      maxBytes: RUNTIME_BUNDLE_MAX_BYTES,
      lastGeneration,
    };
  }

  function log(returnValue: string, logMessage: string = returnValue): string {
    native.log(`kernel: reload ${logMessage}`);
    return returnValue;
  }

  return {
    start(bundle: RuntimeBundle): void {
      const validation = validateRuntimeBundle(bundle, policy());
      if (!validation.ok) throw new Error(`bundle rejected: ${validation.reason}`);
      const root = engine.evaluate(validation.bundle.source, validation.bundle.manifest);
      runtime.mount(root);
      lastGeneration = validation.bundle.manifest.generation;
    },

    stageReload(manifestJson: string, source: string): string {
      const parsedManifest = parseManifestJson(manifestJson);
      if (parsedManifest === MALFORMED_MANIFEST) {
        return log("rejected malformed-manifest", "rejected malformed-manifest (JSON parse error)");
      }
      const manifest = parsedManifest;

      const sourceBytes = encodeAsciiSource(source);
      if (sourceBytes === null) return log("rejected non-ascii");

      const bundle: RuntimeBundle = { manifest, source: sourceBytes };
      let result: ReturnType<Runtime["reloadBundle"]>;
      try {
        result = runtime.reloadBundle(bundle, policy(), engine);
      } catch {
        /* JSON can be syntactically valid but not an object-shaped manifest. */
        return log("rejected malformed-manifest");
      }
      if (result.status === "committed") {
        lastGeneration = manifest.generation;
        return log(`committed ${result.epoch}`, `committed epoch=${result.epoch}`);
      }
      if (result.status === "rolled_back") return log("rolled_back");
      return log(`rejected ${result.reason}`);
    },

    pump(): void {
      scheduler.drain();
    },

    lastGeneration(): number {
      return lastGeneration;
    },

    dispose(): void {
      runtime.unmount();
      board?.dispose();
    },
  };
}
