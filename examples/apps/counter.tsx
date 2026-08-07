import { Button, Screen, Text, useState, type VNode } from "@tsx-lvgl/sdk";

export default function Counter(): VNode {
  const [count, setCount] = useState(0);
  return (
    <Screen>
      <Text text={`count=${count}`} />
      <Button label="increment" onClick={() => setCount((value) => value + 1)} />
    </Screen>
  );
}
