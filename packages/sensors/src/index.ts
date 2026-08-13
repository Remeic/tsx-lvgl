export type SensorStatus = "ok" | "stale" | "unavailable" | "error";

export interface SensorSchema<T> {
  readonly id: string;
  readonly version: number;
  readonly unit?: string;
  readonly validate: (value: unknown) => value is T;
}

export interface SensorError {
  readonly code: string;
  readonly retryable: boolean;
  readonly detail?: string;
}

export interface SensorSample<T> {
  readonly sensorId: string;
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly sampledAtMs: number;
  readonly reloadEpoch: number;
  readonly status: SensorStatus;
  readonly value?: T;
  readonly error?: SensorError;
}

/**
 * Cancellation is a plain predicate rather than an `AbortSignal`: the device
 * engine (QuickJS-NG) ships the ES core, not the web platform, so the contract
 * must not require a host polyfill.
 */
export interface SensorContext {
  readonly reloadEpoch: number;
  isCancelled(): boolean;
}

export interface Sensor<T> {
  readonly schema: SensorSchema<T>;
  read(context: SensorContext): Promise<SensorSample<T>>;
  subscribe(
    listener: (sample: SensorSample<T>) => void,
    context: SensorContext,
  ): () => void;
}

export interface SensorRegistry {
  get<T>(schema: SensorSchema<T>): Sensor<T> | undefined;
}

export interface DeviceCapabilities {
  readonly sensors: SensorRegistry;
}

/** Structural compatibility with the boot-frozen board catalog. */
export type { CapabilitySchema } from "@tsx-lvgl/capabilities";

export interface SensorSubscription {
  cancel(): void;
}

export {
  isMotionSample,
  isShake,
  motionSchema,
  type MotionSample,
  type ShakeThresholds,
} from "./motion.js";

/**
 * Creates the platform-neutral registry used by the runtime composition root.
 * The cast is deliberately contained here: adapters are selected by the board
 * host, while callers recover the type through the schema they provide.
 */
export function createSensorRegistry(sensors: readonly Sensor<any>[]): SensorRegistry {
  const byKey = new Map(sensors.map((sensor) => [schemaKey(sensor.schema), sensor]));
  return {
    get<T>(schema: SensorSchema<T>): Sensor<T> | undefined {
      return byKey.get(schemaKey(schema)) as Sensor<T> | undefined;
    },
  };
}

export function schemaKey(schema: Pick<SensorSchema<unknown>, "id" | "version">): string {
  return `${schema.id}@${schema.version}`;
}

/**
 * Single owner of the fencing policy: cancellation, sequence monotonicity,
 * reload-epoch and schema validation live here, so the UI layer only forwards
 * accepted samples.
 */
export function subscribeSensor<T>(
  sensor: Sensor<T>,
  reloadEpoch: number,
  onSample: (sample: SensorSample<T>) => void,
  onError: (error: unknown) => void,
): SensorSubscription {
  let cancelled = false;
  let lastSequence = 0;
  const context: SensorContext = {
    reloadEpoch,
    isCancelled: () => cancelled,
  };

  const accept = (next: SensorSample<T>): void => {
    if (!cancelled) {
      if (!acceptsSensorSample(next, sensor.schema, reloadEpoch, lastSequence)) return;
      lastSequence = next.sequence;
      onSample(next);
    }
  };

  const unsubscribe = sensor.subscribe(accept, context);
  void sensor.read(context).then(accept, (error: unknown) => {
    if (!cancelled) onError(error);
  });

  return {
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      unsubscribe();
    },
  };
}

export function acceptsSensorSample<T>(
  sample: SensorSample<T>,
  schema: SensorSchema<T>,
  reloadEpoch: number,
  lastSequence: number,
): boolean {
  if (sample.sensorId !== schema.id) return false;
  if (sample.schemaVersion !== schema.version) return false;
  if (sample.reloadEpoch !== reloadEpoch) return false;
  if (!Number.isSafeInteger(sample.sequence) || sample.sequence <= lastSequence) return false;
  if (sample.value === undefined) return sample.status !== "ok";
  return schema.validate(sample.value);
}
