/** @jsxImportSource @lume/core */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compileProject } from "@lume/compiler";
import { Button, Screen, Text, View, normalizeChildren, type UiNode } from "@lume/core";

function Counter(): UiNode {
  return (
    <Screen>
      <Text text={0} />
      <View>
        <Button label="+" action="increment" />
      </View>
    </Screen>
  );
}

test("compiles a TSX tree into deterministic LVGL C", () => {
  const first = compileProject({ root: Counter, projectName: "counter" });
  const second = compileProject({ root: Counter, projectName: "counter" });

  assert.deepEqual(first, second);
  assert.equal(first.manifest.target, "lvgl9-c");
  assert.equal(
    first.files["generated/ui.c"],
    `#include "lvgl.h"

void lume_ui_create(void)
{
    lv_obj_t *root = lv_screen_active();
    lv_obj_t *root_0 = lv_label_create(root);
    lv_label_set_text(root_0, "0");
    lv_obj_t *root_1 = lv_obj_create(root);
    lv_obj_t *root_1_0 = lv_button_create(root_1);
    lv_obj_t *root_1_0_label = lv_label_create(root_1_0);
    lv_label_set_text(root_1_0_label, "+");
    /* Lume action: increment */
}
`,
  );
  assert.equal(
    first.files["generated/manifest.json"],
    `{
  "format": "lume-build-artifacts-v0",
  "projectName": "counter",
  "source": "tsx",
  "target": "lvgl9-c"
}
`,
  );
});

test("escapes C string literals", () => {
  function Escaped(): UiNode {
    return <Screen><Text text={'quote " and slash \\ and\nnewline\r\t\0\x01\b\f\v\x7f'} /></Screen>;
  }

  const result = compileProject({ root: Escaped });
  assert.match(result.files["generated/ui.c"] ?? "", /quote \\" and slash \\\\/);
  assert.match(result.files["generated/ui.c"] ?? "", /and\\nnewline\\r\\t\\000\\001\\b\\f\\v\\177/);
  assert.match(result.files["generated/ui.c"] ?? "", /lume_ui_create/);
});

test("uses a stable default project name", () => {
  function DefaultProject(): UiNode {
    return <Screen><Text text={1} /></Screen>;
  }

  const result = compileProject({ root: DefaultProject });
  assert.equal(result.manifest.projectName, "lume-project");
  assert.match(result.files["generated/manifest.json"] ?? "", /"projectName": "lume-project"/);
});

test("rejects a root component that changes between evaluations", () => {
  let value = 0;
  const stateful = () => <Screen><Text text={value++} /></Screen>;
  assert.throws(
    () => compileProject({ root: stateful }),
    /Root component is not deterministic/,
  );
});

test("normalizes optional and nested children through the public core interface", () => {
  const label = Text({ text: "hello" });
  assert.deepEqual(normalizeChildren([null, [false, label], undefined]), [label]);
});

test("filters every non-node child through the public core interface", () => {
  assert.deepEqual(normalizeChildren([null]), []);
  assert.deepEqual(normalizeChildren([undefined]), []);
  assert.deepEqual(normalizeChildren([false]), []);
  assert.deepEqual(normalizeChildren(["not-a-node" as unknown as UiNode]), []);
});

test("compiles JSX fragments as transparent groups", () => {
  function Fragmented(): UiNode {
    return <Screen><><Text text="inside" /></></Screen>;
  }

  const result = compileProject({ root: Fragmented });
  assert.match(result.files["generated/ui.c"] ?? "", /lv_label_set_text\(root_0_0, "inside"\)/);
});

test("rejects an invalid root node", () => {
  const invalidRoot = (() => ({ kind: "not-an-element" })) as unknown as () => UiNode;
  assert.throws(
    () => compileProject({ root: invalidRoot }),
    /Unsupported node at root/,
  );
});

test("rejects an invalid nested node with its structural path", () => {
  const invalidNested = () => Screen({ children: [{ kind: "not-an-element" } as unknown as UiNode] });
  assert.throws(
    () => compileProject({ root: invalidNested }),
    /Unsupported node at root\.children\[0\]/,
  );
});

test("rejects a non-text value for a text node", () => {
  const invalidText = (() => ({
    kind: "element",
    type: "Text",
    props: { text: { unsupported: true } },
    children: [],
  })) as unknown as () => UiNode;

  assert.throws(
    () => compileProject({ root: invalidText }),
    /Expected string or number at root.text/,
  );
});

test("reports invalid button props at their public paths", () => {
  const invalidLabel = () => Button({ label: { unsupported: true } as unknown as string, action: "increment" });
  assert.throws(
    () => compileProject({ root: invalidLabel }),
    /Expected string or number at root\.label/,
  );

  const invalidAction = () => Button({ label: "+", action: { unsupported: true } as unknown as string });
  assert.throws(
    () => compileProject({ root: invalidAction }),
    /Expected string or number at root\.action/,
  );

  const injectedAction = () => Button({ label: "+", action: "*/\nint injected = 1;\n/*" });
  assert.throws(
    () => compileProject({ root: injectedAction }),
    /Expected C identifier at root\.action/,
  );

  for (const action of ["-ok", "ok!"]) {
    const invalidIdentifier = () => Button({ label: "+", action });
    assert.throws(
      () => compileProject({ root: invalidIdentifier }),
      /Expected C identifier at root\.action/,
    );
  }
});

test("rejects malformed node shapes at the compiler boundary", () => {
  const invalidProps = (() => ({
    kind: "element",
    type: "Text",
    props: null,
    children: [],
  })) as unknown as () => UiNode;
  assert.throws(
    () => compileProject({ root: invalidProps }),
    /Invalid props at root\.props/,
  );

  const primitiveProps = (() => ({
    kind: "element",
    type: "Text",
    props: "not-an-object",
    children: [],
  })) as unknown as () => UiNode;
  assert.throws(
    () => compileProject({ root: primitiveProps }),
    /Invalid props at root\.props/,
  );

  const invalidChildren = (() => ({
    kind: "element",
    type: "Text",
    props: { text: "ok" },
    children: "not-an-array",
  })) as unknown as () => UiNode;
  assert.throws(
    () => compileProject({ root: invalidChildren }),
    /Invalid children at root\.children/,
  );

  const invalidType = (() => ({
    kind: "element",
    type: "Unknown",
    props: {},
    children: [],
  })) as unknown as () => UiNode;
  assert.throws(
    () => compileProject({ root: invalidType }),
    /Unsupported node type at root\.type/,
  );
});
