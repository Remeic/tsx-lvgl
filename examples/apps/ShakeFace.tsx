/**
 * Internal development app — not a published example. Exercises the full
 * bundler -> kernel -> reload path end to end: see `scripts/run-host.mjs`
 * (console demo runner) and `tests/e2e-host.test.tsx` (the MVP-promise test).
 *
 * A little face that toggles happy/sad when the board is shaken.
 */
import { Button, Screen, Text, View, type VNode } from "@tsx-lvgl/core";
import { useEffect, useMotion, useState } from "@tsx-lvgl/runtime";
import { isShake } from "@tsx-lvgl/sensors";

/** Minimum time between accepted shakes, so one physical shake is one toggle. */
const SHAKE_COOLDOWN_MS = 700;

export default function ShakeFace(): VNode {
  const [happy, setHappy] = useState(true);
  // -Infinity: any real sampledAtMs clears the cooldown, so the first shake always counts.
  const [lastShakeAt, setLastShakeAt] = useState(-Infinity);
  const motion = useMotion();

  useEffect(() => {
    if (motion.state.status !== "ready" && motion.state.status !== "stale") return;
    if (!isShake(motion.state.value)) return;
    if (motion.state.observedAtMs - lastShakeAt < SHAKE_COOLDOWN_MS) return;
    setLastShakeAt(motion.state.observedAtMs);
    setHappy((current) => !current);
  }, [motion.state]);

  const imuUnavailable = motion.state.status === "unavailable" || motion.state.status === "error" || motion.state.status === "unsupported";
  const status = imuUnavailable
    ? "IMU non disponibile"
    : happy
      ? "felice - scuotimi"
      : "triste - scuotimi";

  return (
    <Screen>
      <View>
        <Text text="O    O" />
        <Text text={happy ? "\\____/" : "/----\\"} />
        <Text text={status} />
        <Button
          label={happy ? "switch: sad" : "switch: happy"}
          onClick={() => setHappy((current) => !current)}
        />
      </View>
    </Screen>
  );
}
