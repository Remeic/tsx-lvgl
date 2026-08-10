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

const SHAKE_COOLDOWN_MS = 700;

export default function ShakeFace(): VNode {
  const [happy, setHappy] = useState(true);
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
        <Button label={happy ? "switch: sad" : "switch: happy"} onClick={() => setHappy((current) => !current)} />
      </View>
    </Screen>
  );
}
