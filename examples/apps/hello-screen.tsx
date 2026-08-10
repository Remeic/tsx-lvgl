import { Screen, Text, type VNode } from "@tsx-lvgl/sdk";

export default function HelloScreen(): VNode {
  return (
    <Screen>
      <Text text="Hello TSX-LVGL" />
    </Screen>
  );
}
