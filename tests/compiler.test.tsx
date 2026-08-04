/** @jsxImportSource @lume/core */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compileProject } from "@lume/compiler";
import { Button, Screen, Text, View, normalizeChildren, type UiNode } from "@lume/core";
import { Fragment } from "@lume/core/jsx-runtime";

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
    return <Screen><Text text={'quote " and slash \\ and\nnewline'} /></Screen>;
  }

  const result = compileProject({ root: Escaped });
  assert.match(result.files["generated/ui.c"] ?? "", /quote \\" and slash \\\\/);
  assert.match(result.files["generated/ui.c"] ?? "", /and\\nnewline/);
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

test("exposes a stable JSX fragment marker", () => {
  assert.equal(Fragment, "Fragment");
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
});
