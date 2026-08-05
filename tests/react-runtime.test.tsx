/** @jsxImportSource @tsx-lvgl/react */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Button, Fragment, Screen, Text, View, type ReactElement } from "@tsx-lvgl/react";
import { jsx } from "@tsx-lvgl/react/jsx-runtime";

interface RuntimeElementShape {
  readonly kind: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly RuntimeElementShape[];
}

function runtimeShape(value: unknown): RuntimeElementShape {
  return value as RuntimeElementShape;
}

test("React compatibility runtime accepts the source-entry authoring subset", () => {
  assert.doesNotThrow(() => {
    function Tile() {
      return <Text>tile</Text>;
    }
    void Tile;
    // The source compiler owns the accepted intrinsic set; this runtime test
    // exercises the same public JSX declaration with valid compatibility code.
    const tree = <Screen><Tile /></Screen>;
    void tree;
  });
});

test("React compatibility runtime rejects primitive container children", () => {
  assert.throws(
    () => Screen({ children: "not a UI element" as never }),
    /accept UI elements as children/,
  );
});

test("React compatibility runtime preserves the full nullish child contract", () => {
  const child = <Text>kept</Text>;
  for (const value of [null, undefined, false, [], [null, false, child], child]) {
    assert.doesNotThrow(() => Screen({ children: value as never }));
    assert.doesNotThrow(() => Text({ children: "child" }));
    assert.doesNotThrow(() => Text({ text: 0 }));
    assert.doesNotThrow(() => Button({ children: "go", onClick: () => undefined }));
    assert.doesNotThrow(() => Button({ label: "go", onClick: () => undefined }));
  }
  for (const value of [true, 0, {}, { kind: "not-an-element" }]) {
    assert.throws(
      () => Screen({ children: value as never }),
      /accept UI elements as children/,
    );
  }
  const forgedFunction = Object.assign(() => undefined, { kind: "element" });
  assert.throws(
    () => Screen({ children: forgedFunction as never }),
    /accept UI elements as children/,
  );
  assert.deepEqual(runtimeShape(View({})), {
    kind: "element",
    type: "View",
    props: {},
    children: [],
  });
  assert.deepEqual(runtimeShape(View({ direction: "row" } as const)).props, { direction: "row" });
  assert.deepEqual(runtimeShape(View({ align: "center" } as const)).props, { align: "center" });
  assert.deepEqual(runtimeShape(View({ gap: 8 })).props, { gap: 8 });
  assert.throws(() => Text({ text: undefined as never }), /Text requires/);
  assert.throws(() => Text({ children: undefined as never }), /Text requires/);
  assert.throws(() => Button({ label: undefined as never, onClick: () => undefined }), /Button requires/);
  assert.throws(() => Button({ children: undefined as never, onClick: () => undefined }), /Button requires/);
});

test("React compatibility runtime does not drop meaningful custom-component children", () => {
  function Tile() {
    return <Text>tile</Text>;
  }

  assert.throws(
    () => jsx(Tile, { children: <Text>lost</Text> }),
    /component children are unsupported in this MVP/,
  );
  assert.throws(
    () => jsx(Tile, { children: "lost" }),
    /component children are unsupported in this MVP/,
  );
  assert.throws(
    () => jsx(Tile, { children: [null, <Text>lost</Text>] }),
    /component children are unsupported in this MVP/,
  );
  assert.throws(
    () => jsx(Tile, { children: [false, true] }),
    /component children are unsupported in this MVP/,
  );
  for (const child of [null, undefined, false]) {
    assert.doesNotThrow(() => jsx(Tile, { children: child }));
  }
  assert.doesNotThrow(() => jsx(Tile, { children: [] }));
  assert.doesNotThrow(() => jsx(Tile, { children: " \n\t" }));
});

test("jsx runtime covers intrinsic fallback and fragment normalization", () => {
  const child = <Text>fallback</Text>;
  assert.deepEqual(
    jsx("Screen", { children: [null, false, child] }) as unknown as Record<string, unknown>,
    {
      kind: "element",
      type: "Screen",
      props: {},
      children: [child as unknown as Record<string, unknown>],
    },
  );
  const fragment = jsx(Fragment as unknown as () => ReactElement, { children: [null, false, child] }) as unknown as {
    readonly children: readonly unknown[];
  };
  assert.equal(fragment.children.length, 1);
  assert.equal((fragment.children[0] as { readonly type: string }).type, "Text");
});
