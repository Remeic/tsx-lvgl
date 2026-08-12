import { Button, Screen, Text, isShake, useMotion, useState, type VNode } from "@tsx-lvgl/sdk";

export default function Counter(): VNode {
  const [count, setCount] = useState(0);
  const motion = useMotion();
  const motionText = motion.state.status === "ready" || motion.state.status === "stale"
    ? `motion=${isShake(motion.state.value) ? "SHAKE" : "STILL"}`
    : `motion=${motion.state.status}`;

  return (
    <Screen>
      <Text text={`count=${count}`} />
      <Text text={motionText} />
      <Button label="increment" onClick={() => setCount((value) => value + 1)} />
    </Screen>
  );
}
