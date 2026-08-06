/** @jsxImportSource @tsx-lvgl/react */

import { Screen, Text, View } from "@tsx-lvgl/react";

// A compile-time map over an array literal unrolls to fixed children. The item
// flows straight into the component's props pipeline.
function Row({ value }: { value: number }) {
  return <Text text={value} />;
}

function Menu() {
  return (
    <Screen>
      <View direction="column" gap={4}>
        {[10, 20, 30].map((value) => (
          <Row value={value} />
        ))}
      </View>
    </Screen>
  );
}

export default Menu;
