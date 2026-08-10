import { Screen, Text, useMotion, type VNode } from "@tsx-lvgl/sdk";

export default function SensorReadout(): VNode {
  const motion = useMotion();
  const text = motion.state.status === "starting"
    ? "motion: waiting"
    : motion.state.status !== "ready" && motion.state.status !== "stale"
      ? `motion: ${motion.state.status}`
      : `motion: x=${motion.state.value.accelerationMps2[0]}`;
  return (
    <Screen>
      <Text text={text} />
    </Screen>
  );
}
