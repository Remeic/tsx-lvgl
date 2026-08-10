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
  const sample = useMotion();

  useEffect(() => {
    if (sample === undefined || sample.status !== "ok" || sample.value === undefined) return;
    if (!isShake(sample.value)) return;
    if (sample.sampledAtMs - lastShakeAt < SHAKE_COOLDOWN_MS) return;
    setLastShakeAt(sample.sampledAtMs);
    setHappy((current) => !current);
  }, [sample]);

  const imuUnavailable = sample !== undefined && sample.status !== "ok";
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
