/** @jsxImportSource @tsx-lvgl/react */

import { Button, Screen, Text, View, useState } from "@tsx-lvgl/react";

// Props are resolved at compile time by inlining each component instance.
// Literal props become constants; a state prop forwards the caller's slot.
function Labeled({ title, value }: { title: string; value: number }) {
  return (
    <View direction="row" gap={8}>
      <Text text={title} />
      <Text text={value} />
    </View>
  );
}

function Panel() {
  const [count, setCount] = useState(0);

  return (
    <Screen>
      <Labeled title="static" value={42} />
      <Labeled title="live" value={count} />
      <Button label="+" onClick={() => setCount((previous) => previous + 1)} />
    </Screen>
  );
}

export default Panel;
