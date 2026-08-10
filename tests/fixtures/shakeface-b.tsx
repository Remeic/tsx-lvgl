/**
 * Variant B of `tests/fixtures/shakeface-a.tsx` — a hot-reload target for
 * `tests/e2e-host.test.tsx` and `scripts/run-host.mjs --reload`. Read as TEXT
 * via `node:fs` and compiled at runtime through `compileTsxBundle`; it is not
 * a `*.test.*` file, so `node --test` does not pick it up on its own. Kept
 * valid TSX (rather than a raw string fixture) for free type safety, since
 * `tsconfig.tests.json` includes `tests/**\/*.tsx`.
 */
import {
  Button,
  Screen,
  Text,
  View,
  isShake,
  useEffect,
  useMotion,
  useState,
  type VNode,
} from "@tsx-lvgl/sdk";

/** Minimum time between accepted shakes, so one physical shake is one toggle. */
const SHAKE_COOLDOWN_MS = 700;

export default function ShakeFaceB(): VNode {
  const [happy, setHappy] = useState(true);
  // -Infinity: any real observedAtMs clears the cooldown, so the first shake always counts.
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
