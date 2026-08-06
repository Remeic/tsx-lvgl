/** @jsxImportSource @tsx-lvgl/react */

import { Button, Screen, Text, useState } from "@tsx-lvgl/react";

// Derived integer expressions over state lower to saturating int32 arithmetic,
// recomputed into each label whenever the state changes.
function Derived() {
  const [count, setCount] = useState(1);

  return (
    <Screen>
      <Text text={count} />
      <Text text={count * count} />
      <Text text={count * 2 + 1} />
      <Button label="+" onClick={() => setCount((previous) => previous + 1)} />
      <Button label="double" onClick={() => setCount((previous) => previous * 2)} />
    </Screen>
  );
}

export default Derived;
