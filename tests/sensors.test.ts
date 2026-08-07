import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  acceptsSensorSample,
  createSensorRegistry,
  isMotionSample,
  isShake,
  motionSchema,
  schemaKey,
  subscribeSensor,
  type SensorContext,
  type SensorSample,
  type SensorSchema,
} from "@tsx-lvgl/sensors";
import { FakeSensor, sample, uptimeSchema } from "./support/harness.js";

test("createSensorRegistry resolves sensors by schema id and version", () => {
  const sensor = new FakeSensor();
  const registry = createSensorRegistry([sensor]);
  assert.equal(registry.get(uptimeSchema), sensor);
  assert.equal(registry.get({ ...uptimeSchema, version: 2 }), undefined);
});

test("acceptsSensorSample fences sensor id, schema version, reload epoch, sequence regressions, and payload validity", () => {
  const context: SensorContext = { reloadEpoch: 3, isCancelled: () => false };
  const accepted = sample(context, 4, 42);

  assert.equal(schemaKey(uptimeSchema), "board.uptime@1");
  assert.equal(acceptsSensorSample(accepted, uptimeSchema, 3, 3), true);
  assert.equal(acceptsSensorSample({ ...accepted, sensorId: "other" }, uptimeSchema, 3, 3), false);
  assert.equal(acceptsSensorSample({ ...accepted, reloadEpoch: 2 }, uptimeSchema, 3, 3), false);
  assert.equal(acceptsSensorSample({ ...accepted, schemaVersion: 2 }, uptimeSchema, 3, 3), false);
  assert.equal(acceptsSensorSample({ ...accepted, sequence: 3 }, uptimeSchema, 3, 3), false);
  assert.equal(acceptsSensorSample({ ...accepted, sequence: Number.NaN }, uptimeSchema, 3, 3), false);
  assert.equal(
    acceptsSensorSample({ ...accepted, value: "not-a-number" as unknown as number }, uptimeSchema, 3, 3),
    false,
  );
  assert.equal(
    acceptsSensorSample({ ...accepted, status: "ok", value: undefined }, uptimeSchema, 3, 3),
    false,
  );

  const permissiveSchema: SensorSchema<number | undefined> = {
    id: "board.optional",
    version: 1,
    validate: (value: unknown): value is number | undefined => true,
  };
  assert.equal(
    acceptsSensorSample(
      { ...accepted, sensorId: permissiveSchema.id, schemaVersion: permissiveSchema.version, value: undefined },
      permissiveSchema,
      3,
      3,
    ),
    false,
  );
  assert.equal(
    acceptsSensorSample({ ...accepted, status: "stale", value: undefined }, uptimeSchema, 3, 3),
    true,
  );
  assert.equal(
    acceptsSensorSample({ ...accepted, status: "stale", value: "not-a-number" as unknown as number }, uptimeSchema, 3, 3),
    false,
  );
});

test("subscribeSensor threads reloadEpoch through the context and accepts the eager read", async () => {
  const sensor = new FakeSensor();
  const received: SensorSample<number>[] = [];
  const errors: unknown[] = [];

  subscribeSensor(sensor, 3, (next) => received.push(next), (error) => errors.push(error));
  const context = sensor.contexts[0];
  assert.ok(context);
  assert.equal(context.reloadEpoch, 3);
  assert.equal(context.isCancelled(), false);

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(received.map((next) => next.sequence), [1]);
  assert.deepEqual(errors, []);
});

test("subscribeSensor only forwards increasing sequences within the subscribed reload epoch", () => {
  // Deferred so the eager `read()` never resolves and cannot interleave with these `emit`s.
  const sensor = new FakeSensor({ deferred: true });
  const received: SensorSample<number>[] = [];
  subscribeSensor(sensor, 3, (next) => received.push(next), () => undefined);
  const context = sensor.contexts[0]!;

  sensor.emit(sample(context, 1, 20));
  assert.equal(received.length, 1);
  sensor.emit(sample(context, 1, 21)); // duplicate sequence, ignored
  assert.equal(received.length, 1);
  sensor.emit({ ...sample(context, 2, 30), reloadEpoch: context.reloadEpoch + 1 }); // wrong epoch
  assert.equal(received.length, 1);
  sensor.emit(sample(context, 2, 30));
  assert.equal(received.length, 2);
});

test("cancelling a subscription unsubscribes, fences further samples, and is idempotent", () => {
  const sensor = new FakeSensor();
  const received: SensorSample<number>[] = [];
  const subscription = subscribeSensor(sensor, 1, (next) => received.push(next), () => undefined);
  const context = sensor.contexts[0]!;
  assert.equal(sensor.listeners.length, 1);
  assert.equal(context.isCancelled(), false);

  const staleListener = sensor.listeners[0]!;
  subscription.cancel();
  assert.equal(context.isCancelled(), true);
  assert.equal(sensor.listeners.length, 0);
  assert.doesNotThrow(() => subscription.cancel());
  assert.equal(sensor.unsubscribeCalls, 1, "cancellation must unsubscribe the native sensor exactly once");

  staleListener(sample(context, 1, 98));
  assert.equal(received.length, 0, "a stale callback must be fenced even if unsubscribe races with delivery");
  sensor.emit(sample(context, 2, 99));
  assert.equal(received.length, 0);
});

test("a read() rejection reaches onError, but not once the subscription is cancelled", async () => {
  const cancelledFirst = new FakeSensor({ deferred: true });
  const cancelledErrors: unknown[] = [];
  const cancelledSubscription = subscribeSensor(cancelledFirst, 1, () => undefined, (error) => cancelledErrors.push(error));
  cancelledSubscription.cancel();
  cancelledFirst.reject(new Error("aborted sensor read"));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(cancelledErrors, []);

  const active = new FakeSensor({ deferred: true });
  const activeErrors: unknown[] = [];
  subscribeSensor(active, 1, () => undefined, (error) => activeErrors.push(error));
  active.reject(new Error("sensor read failed"));
  await Promise.resolve();
  await Promise.resolve();
  assert.match(String(activeErrors.at(-1)), /sensor read failed/);
});

test("motion schema accepts finite three-axis samples and rejects malformed payloads", () => {
  const still = {
    accelerationMps2: [0, 0, 9.80665] as const,
    angularVelocityDps: [0, 0, 0] as const,
  };

  assert.equal(isMotionSample(still), true);
  assert.equal(motionSchema.validate(still), true);
  assert.equal(isMotionSample(null), false);
  assert.equal(isMotionSample({ accelerationMps2: still.accelerationMps2 }), false);
  assert.equal(
    isMotionSample({
      accelerationMps2: [0, 0, Number.NaN],
      angularVelocityDps: still.angularVelocityDps,
    }),
    false,
  );
  assert.equal(
    isMotionSample({
      accelerationMps2: [0, 0, 9.80665, 1],
      angularVelocityDps: still.angularVelocityDps,
    }),
    false,
  );
});

test("isShake detects either a linear impulse or a fast rotation, but not a stationary sample", () => {
  const stationary = {
    accelerationMps2: [0, 0, 9.80665] as const,
    angularVelocityDps: [0, 0, 0] as const,
  };
  const linearImpulse = {
    ...stationary,
    accelerationMps2: [20, 0, 0] as const,
  };
  const fastRotation = {
    ...stationary,
    angularVelocityDps: [200, 0, 0] as const,
  };

  assert.equal(isShake(stationary), false);
  assert.equal(isShake(linearImpulse), true);
  assert.equal(isShake(fastRotation), true);
});

test("motionSchema declares the exact id, version, and unit the reload fence keys on", () => {
  assert.equal(motionSchema.id, "board.qmi8658.motion");
  assert.equal(motionSchema.version, 1);
  assert.equal(motionSchema.unit, "m/s2+dps");
});

test("isMotionSample rejects undefined without ever dereferencing it as an object", () => {
  // Distinguishes the `typeof value !== "object"` guard from the `value === null`
  // guard: `undefined` fails `typeof`, but is not `=== null`, so if the `typeof`
  // check were ever dropped, the function would fall through and throw on
  // property access instead of returning false.
  assert.equal(isMotionSample(undefined), false);
});

test("isVector rejects a vector whose axes are not all numbers, via isMotionSample", () => {
  // Exercises the `.every(...)` predicate's false branch on a non-numeric axis
  // rather than the length/array checks already covered above.
  assert.equal(
    isMotionSample({
      accelerationMps2: [0, "not-a-number", 9.80665],
      angularVelocityDps: [0, 0, 0],
    }),
    false,
  );
});

test("isShake acceleration delta is a >= boundary: exactly at the threshold shakes, just under does not", () => {
  // EARTH_GRAVITY_MPS2 ~= 9.80665, SHAKE_ACCELERATION_DELTA_MPS2 = 6.
  // Pick a pure X-axis acceleration so magnitude == accelerationMps2[0] exactly,
  // landing precisely on gravity + delta / just under it.
  const atThreshold = {
    accelerationMps2: [9.80665 + 6, 0, 0] as const,
    angularVelocityDps: [0, 0, 0] as const,
  };
  const justUnderThreshold = {
    accelerationMps2: [9.80665 + 6 - 0.0001, 0, 0] as const,
    angularVelocityDps: [0, 0, 0] as const,
  };

  assert.equal(isShake(atThreshold), true, ">= threshold must shake");
  assert.equal(isShake(justUnderThreshold), false, "just under threshold must not shake");
});

test("isShake angular velocity delta is a >= boundary: exactly at the threshold shakes, just under does not", () => {
  // SHAKE_ANGULAR_VELOCITY_DPS = 180. Keep acceleration stationary so only the
  // rotation term can trigger the shake.
  const stationaryAccel = [0, 0, 9.80665] as const;
  const atThreshold = {
    accelerationMps2: stationaryAccel,
    angularVelocityDps: [180, 0, 0] as const,
  };
  const justUnderThreshold = {
    accelerationMps2: stationaryAccel,
    angularVelocityDps: [180 - 0.0001, 0, 0] as const,
  };

  assert.equal(isShake(atThreshold), true, ">= threshold must shake");
  assert.equal(isShake(justUnderThreshold), false, "just under threshold must not shake");
});
