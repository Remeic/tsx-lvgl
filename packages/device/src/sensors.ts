import {
  motionSchema,
  type MotionSample,
  type Sensor,
  type SensorContext,
  type SensorSample,
  type SensorStatus,
} from "@tsx-lvgl/sensors";
import type { NativeSensors, NativeTimers } from "./native.js";

const DEFAULT_PERIOD_MS = 80;

/**
 * The shape `NativeSensors.read` is documented to return for the motion
 * sensor: everything a `SensorSample` needs except the fencing fields
 * (`sequence`, `reloadEpoch`), which only the JS side can assign.
 */
interface NativeMotionReading {
  readonly status: SensorStatus;
  readonly sampledAtMs: number;
  readonly value?: unknown;
}

function toSample(raw: unknown, context: SensorContext, sequence: number): SensorSample<MotionSample> {
  const reading = raw as NativeMotionReading;
  const value = reading.value;
  // No `value !== undefined` short-circuit: motionSchema.validate(undefined)
  // already returns false safely (isMotionSample's typeof check rejects it
  // before touching it as an object), so the guard would be redundant.
  const hasValidValue = motionSchema.validate(value);
  return {
    sensorId: motionSchema.id,
    schemaVersion: motionSchema.version,
    sequence,
    sampledAtMs: reading.sampledAtMs,
    reloadEpoch: context.reloadEpoch,
    status: reading.status,
    ...(hasValidValue ? { value } : {}),
  };
}

/**
 * Adapts the native QMI8658 binding to the `Sensor<MotionSample>` contract
 * `@tsx-lvgl/sensors` expects: a bounded `read()` that resolves once, and a
 * `subscribe()` that polls the native timer at `periodMs` and forwards each
 * sample restamped with the caller's reload epoch and this sensor's own
 * monotonic sequence counter (shared across `read` and `subscribe` so
 * `subscribeSensor`'s monotonicity fence never rejects a live sample).
 */
export function createNativeMotionSensor(
  native: NativeSensors,
  timers: NativeTimers,
  periodMs: number = DEFAULT_PERIOD_MS,
): Sensor<MotionSample> {
  let sequence = 0;

  return {
    schema: motionSchema,

    read(context: SensorContext): Promise<SensorSample<MotionSample>> {
      sequence += 1;
      return Promise.resolve(toSample(native.read(motionSchema.id), context, sequence));
    },

    subscribe(listener: (sample: SensorSample<MotionSample>) => void, context: SensorContext): () => void {
      const handle = timers.setInterval(() => {
        sequence += 1;
        listener(toSample(native.read(motionSchema.id), context, sequence));
      }, periodMs);
      return () => timers.clearInterval(handle);
    },
  };
}
