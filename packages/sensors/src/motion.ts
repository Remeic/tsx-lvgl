import type { SensorSchema } from "./index.js";

export interface MotionSample {
  readonly accelerationMps2: readonly [number, number, number];
  readonly angularVelocityDps: readonly [number, number, number];
}

export const motionSchema: SensorSchema<MotionSample> = {
  id: "device.motion",
  version: 1,
  unit: "m/s2+dps",
  validate: isMotionSample,
};

const EARTH_GRAVITY_MPS2 = 9.80665;
const SHAKE_ACCELERATION_DELTA_MPS2 = 6;
const SHAKE_ANGULAR_VELOCITY_DPS = 180;

export function isMotionSample(value: unknown): value is MotionSample {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isVector(candidate.accelerationMps2) && isVector(candidate.angularVelocityDps);
}

export function isShake(sample: MotionSample): boolean {
  const accelerationMagnitude = magnitude(sample.accelerationMps2);
  const rotationMagnitude = magnitude(sample.angularVelocityDps);
  return Math.abs(accelerationMagnitude - EARTH_GRAVITY_MPS2) >= SHAKE_ACCELERATION_DELTA_MPS2
    || rotationMagnitude >= SHAKE_ANGULAR_VELOCITY_DPS;
}

type MotionVector = readonly [number, number, number];

function isVector(value: unknown): value is MotionVector {
  return Array.isArray(value)
    && value.length === 3
    && value.every((axis) => Number.isFinite(axis));
}

function magnitude(vector: MotionVector): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}
