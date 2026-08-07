/**
 * Variant B of `examples/apps/ShakeFace.tsx` — a hot-reload target for
 * `tests/e2e-host.test.tsx` and `scripts/run-host.mjs --reload`. Read as TEXT
 * via `node:fs` and compiled at runtime through `compileTsxBundle`; it is not
 * a `*.test.*` file, so `node --test` does not pick it up on its own. Kept
 * valid TSX (rather than a raw string fixture) for free type safety, since
 * `tsconfig.tests.json` includes `tests/**\/*.tsx`.
 */
import { Button, Screen, Text, View, type VNode } from "@tsx-lvgl/core";
import { useEffect, useSensor, useState } from "@tsx-lvgl/runtime";
import { isShake, motionSchema } from "@tsx-lvgl/sensors";

/** Minimum time between accepted shakes, so one physical shake is one toggle. */
const SHAKE_COOLDOWN_MS = 700;

export default function ShakeFaceB(): VNode {
  const [happy, setHappy] = useState(true);
  // -Infinity: any real sampledAtMs clears the cooldown, so the first shake always counts.
  const [lastShakeAt, setLastShakeAt] = useState(-Infinity);
  const sample = useSensor(motionSchema);

  useEffect(() => {
    if (sample === undefined) return;
    if (sample.status !== "ok" || sample.value === undefined) return;
    if (!isShake(sample.value)) return;
    if (sample.sampledAtMs - lastShakeAt < SHAKE_COOLDOWN_MS) return;
    setLastShakeAt(sample.sampledAtMs);
    setHappy((current) => !current);
  }, [sample]);

  const imuUnavailable = sample !== undefined && sample.status !== "ok";
  const status = imuUnavailable
    ? "B: IMU non disponibile"
    : happy
      ? "B: felice - scuotimi"
      : "B: triste - scuotimi";

  return (
    <Screen>
      <View>
        <Text text="O    O" />
        <Text text={happy ? "^----^" : "v----v"} />
        <Text text={status} />
        <Button
          label={happy ? "switch: sad" : "switch: happy"}
          onClick={() => setHappy((current) => !current)}
        />
      </View>
    </Screen>
  );
}
