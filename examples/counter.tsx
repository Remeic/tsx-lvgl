/** @jsxImportSource @tsx-lvgl/react */

import { Button, Screen, Text, useState } from "@tsx-lvgl/react";

function Counter() {
  const [count, setCount] = useState(0);
  const increment = () => setCount((previous) => previous + 1);

  return (
    <Screen>
      <Text text={count} />
      <Button label="+" onClick={increment} />
    </Screen>
  );
}

export default Counter;
