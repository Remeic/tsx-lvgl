import { Screen, Text, useMotion, type VNode } from "@tsx-lvgl/sdk";

export default function SensorReadout(): VNode {
  const sample = useMotion();
  const text = sample === undefined
    ? "motion: waiting"
    : sample.status !== "ok" || sample.value === undefined
      ? `motion: ${sample.status}`
      : `motion: x=${sample.value.accelerationMps2[0]}`;
  return (
    <Screen>
      <Text text={text} />
    </Screen>
  );
}
