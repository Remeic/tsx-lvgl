/** @jsxImportSource @tsx-lvgl/react */

import { Button, Screen, Text, useState } from "@tsx-lvgl/react";

// State-driven conditionals lower to fixed LVGL objects toggled by a hidden
// flag: both branches are created once, never rebuilt.
function Gate() {
  const [count, setCount] = useState(0);

  return (
    <Screen>
      <Text text={count} />
      {count > 0 ? <Text text="positive" /> : <Text text="zero" />}
      {count > 2 && <Text text="high" />}
      <Button label="+" onClick={() => setCount((previous) => previous + 1)} />
    </Screen>
  );
}

export default Gate;
