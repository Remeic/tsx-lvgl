/** @jsxImportSource @tsx-lvgl/react */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Button, Screen, Text, View } from "@tsx-lvgl/react";
import type { ButtonProps, ScreenProps, ViewProps } from "@tsx-lvgl/react";

function Tile() {
  return <View direction="row"><Text>tile</Text></View>;
}

const validTree = <Screen><Tile /><Tile /></Screen>;
void validTree;

// TypeScript permits JSX children on a zero-parameter function; source
// compilation and the runtime guard reject the unsupported child explicitly.
if (false) {
  const invalidTileChildren = <Tile><Text>lost</Text></Tile>;
  void invalidTileChildren;
}

interface RuntimeElementShape {
  readonly kind: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly RuntimeElementShape[];
}

function runtimeShape(value: unknown): RuntimeElementShape {
  return value as RuntimeElementShape;
}

// @ts-expect-error Screen children are UI elements, not primitive text.
const invalidScreenChildren: ScreenProps = { children: "not a node" };
void invalidScreenChildren;

// @ts-expect-error View children are UI elements, not primitive numbers.
const invalidViewChildren: ViewProps = { children: 1 };
void invalidViewChildren;

// @ts-expect-error The legacy core action prop is not part of the React subset.
const invalidButtonProps: ButtonProps = { label: "x", action: "legacy", onClick: () => undefined };
void invalidButtonProps;

// @ts-expect-error Generic prop-bearing FC types are intentionally not public.
import type { FC } from "@tsx-lvgl/react";

// @ts-expect-error Low-level core element constructors are intentionally not public.
import type { element } from "@tsx-lvgl/react";

test("React compatibility runtime accepts the same structural subset", () => {
  const click = () => undefined;
  const text = runtimeShape(<Text text={0} />);
  assert.deepEqual(text, { kind: "element", type: "Text", props: { text: 0 }, children: [] });
  const button = runtimeShape(<Button label="go" onClick={click} />);
  assert.equal(button.kind, "element");
  assert.equal(button.type, "Button");
  assert.equal(button.props.label, "go");
  assert.equal(button.props.onClick, click);
  const layout = runtimeShape(<View direction="row" align="center" gap={8}><Text>inside</Text></View>);
  assert.deepEqual(layout.props, { direction: "row", align: "center", gap: 8 });
  assert.equal(layout.children.length, 1);
  assert.equal(layout.children[0]?.type, "Text");
  const screen = runtimeShape(<Screen><Tile /><View gap={8}><Text text={0} /></View></Screen>);
  assert.equal(screen.type, "Screen");
  assert.equal(screen.children.length, 2);
  assert.equal(runtimeShape(<><Text>fragment</Text></>).type, "Fragment");
  assert.throws(
    () => Screen({ children: "primitive" as never }),
    /accept UI elements as children/,
  );
});
