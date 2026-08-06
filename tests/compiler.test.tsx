/** @jsxImportSource @tsx-lvgl/core */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compileProject } from "@tsx-lvgl/compiler";
import { Button, Screen, Text, View, element, normalizeChildren, type UiNode } from "@tsx-lvgl/core";

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

static void tsx_lvgl_action_increment(lv_event_t *event)
{
    lv_obj_t *label = lv_event_get_user_data(event);
    lv_label_set_text(label, "Touched");
}

void tsx_lvgl_ui_create(void)
{
    lv_obj_t *root = lv_screen_active();
    lv_obj_set_flex_flow(root, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(root, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_t *root_0 = lv_label_create(root);
    lv_label_set_text(root_0, "0");
    lv_obj_t *root_1 = lv_obj_create(root);
    lv_obj_set_flex_flow(root_1, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(root_1, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_t *root_1_0 = lv_button_create(root_1);
    lv_obj_t *root_1_0_label = lv_label_create(root_1_0);
    lv_label_set_text(root_1_0_label, "+");
    lv_obj_center(root_1_0_label);
    lv_obj_add_event_cb(root_1_0, tsx_lvgl_action_increment, LV_EVENT_CLICKED, root_1_0_label);
}
`,
  );
  assert.equal(
    first.files["generated/manifest.json"],
    `{
  "format": "tsx-lvgl-build-artifacts-v0",
  "projectName": "counter",
  "source": "tsx",
  "target": "lvgl9-c"
}
`,
  );
});

test("escapes C string literals", () => {
  function Escaped(): UiNode {
    return <Screen><Text text={'quote " and slash \\ and\nnewline\r\t\0\x01\b\f\v\x7f and trigraph ??/ ??= ??\''} /></Screen>;
  }

  const result = compileProject({ root: Escaped });
  assert.match(result.files["generated/ui.c"] ?? "", /quote \\" and slash \\\\/);
  assert.match(result.files["generated/ui.c"] ?? "", /and\\nnewline\\r\\t\\000\\001\\b\\f\\v\\177/);
  assert.ok((result.files["generated/ui.c"] ?? "").includes("trigraph \\?\\?/ \\?\\?="));
  assert.match(result.files["generated/ui.c"] ?? "", /tsx_lvgl_ui_create/);
});

test("uses a stable default project name", () => {
  function DefaultProject(): UiNode {
    return <Screen><Text text={1} /></Screen>;
  }

  const result = compileProject({ root: DefaultProject });
  assert.equal(result.manifest.projectName, "tsx-lvgl-project");
  assert.match(result.files["generated/manifest.json"] ?? "", /"projectName": "tsx-lvgl-project"/);
});

test("rejects a root component that changes between evaluations", () => {
  let value = 0;
  const stateful = () => <Screen><Text text={value++} /></Screen>;
  assert.throws(
    () => compileProject({ root: stateful }),
    /Root component is not deterministic/,
  );
});

test("rejects a root component that reads a changing clock", () => {
  let clock = 1700000000;
  const timeVarying = () => <Screen><Text text={clock++} /></Screen>;
  assert.throws(
    () => compileProject({ root: timeVarying }),
    /Root component is not deterministic/,
  );
});

test("rejects random-like root variation without timing races", () => {
  const samples = [0.25, 0.75];
  const randomLike = () => <Screen><Text text={samples.shift() ?? 0} /></Screen>;
  assert.throws(
    () => compileProject({ root: randomLike }),
    /Root component is not deterministic/,
  );
});

test("normalizes optional and nested children through the public core interface", () => {
  const label = Text({ text: "hello" });
  assert.deepEqual(normalizeChildren([null, [false, label], undefined]), [label]);
});

test("uses an empty child list when element children are omitted", () => {
  assert.deepEqual(element("View", {}).children, []);
});

test("filters every non-node child through the public core interface", () => {
  assert.deepEqual(normalizeChildren([null]), []);
  assert.deepEqual(normalizeChildren([undefined]), []);
  assert.deepEqual(normalizeChildren([false]), []);
  assert.deepEqual(normalizeChildren(["not-a-node" as unknown as UiNode]), []);
  assert.deepEqual(normalizeChildren([(() => "not-a-node") as unknown as UiNode]), []);
});

test("rejects object-shaped malformed children instead of dropping them", () => {
  assert.throws(
    () => normalizeChildren([{ kind: "not-an-element" } as unknown as UiNode]),
    /Invalid child at children\[0\]/,
  );
  assert.throws(
    () => normalizeChildren([[{ kind: "not-an-element" } as unknown as UiNode]]),
    /Invalid child at children\[0\]\[0\]/,
  );
  assert.throws(
    () => normalizeChildren([{
      kind: "not-an-element",
      type: "Text",
      props: {},
      children: [],
    } as unknown as UiNode]),
    /Invalid child at children\[0\]/,
  );
  assert.throws(
    () => normalizeChildren([{
      kind: "element",
      type: "Text",
      props: null,
      children: [],
    } as unknown as UiNode]),
    /Invalid child at children\[0\]/,
  );
});

test("recognizes every supported core node type and rejects unknown types", () => {
  for (const type of ["Screen", "View", "Text", "Button", "Fragment"]) {
    assert.equal(
      normalizeChildren([{
        kind: "element",
        type,
        props: {},
        children: [],
      } as unknown as UiNode]).length,
      1,
    );
  }
  assert.throws(
    () => normalizeChildren([{
      kind: "element",
      type: "Unknown",
      props: {},
      children: [],
    } as unknown as UiNode]),
    /Invalid child at children\[0\]/,
  );
});

test("compiles JSX fragments as transparent groups", () => {
  function Fragmented(): UiNode {
    return <Screen><><Text text="inside" /></></Screen>;
  }

  const result = compileProject({ root: Fragmented });
  assert.match(result.files["generated/ui.c"] ?? "", /lv_label_set_text\(root_0_0, "inside"\)/);
});

test("legacy JSX runtime requires the legacy leaf props", () => {
  const numberText = <Text text={42} />;
  const stringButton = <Button label="+" action="increment" />;
  function Nested(): UiNode {
    return <View><Text text="nested" /></View>;
  }
  const nested = <Nested />;

  assert.equal(numberText.props.text, 42);
  assert.equal(stringButton.props.label, "+");
  assert.equal(nested.type, "View");
  assert.equal(nested.children.length, 1);
  assert.equal(nested.children[0]?.type, "Text");
});

test("legacy runtime rejects React-only layout props at the compiler boundary", () => {
  const legacyWithReactProps = (() => ({
    kind: "element",
    type: "View",
    props: { direction: "row", gap: 8, onClick: () => undefined },
    children: [],
  })) as unknown as () => UiNode;
  assert.throws(
    () => compileProject({ root: legacyWithReactProps }),
    /Invalid props at root\.props\.direction/,
  );
});

test("rejects an invalid root node", () => {
  const invalidRoot = (() => ({ kind: "not-an-element" })) as unknown as () => UiNode;
  assert.throws(
    () => compileProject({ root: invalidRoot }),
    /Unsupported node at root/,
  );
});

test("rejects an invalid nested node with its structural path", () => {
  const invalidNested = (() => ({
    kind: "element",
    type: "Screen",
    props: {},
    children: [{ kind: "not-an-element" }],
  })) as unknown as () => UiNode;
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

test("rejects children on leaf widgets", () => {
  const textWithChildren = (() => ({
    kind: "element",
    type: "Text",
    props: { text: "parent" },
    children: [Text({ text: "discarded" })],
  })) as unknown as () => UiNode;

  assert.throws(
    () => compileProject({ root: textWithChildren }),
    /Invalid children at root\.children: Text does not accept children/,
  );
});

test("reports invalid button props at their public paths", () => {
  const invalidLabel = () => Button({ label: { unsupported: true } as unknown as string, action: "increment" });
  assert.throws(
    () => compileProject({ root: invalidLabel }),
    /Expected string at root\.label/,
  );

  const invalidAction = () => Button({ label: "+", action: { unsupported: true } as unknown as string });
  assert.throws(
    () => compileProject({ root: invalidAction }),
    /Expected string at root\.action/,
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
    (error: unknown) => error instanceof Error && error.message === "Invalid props at root.props",
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

  const invalidScreenChildren = (() => ({
    kind: "element",
    type: "Screen",
    props: {},
    children: "not-an-array",
  })) as unknown as () => UiNode;
  assert.throws(
    () => compileProject({ root: invalidScreenChildren }),
    /Invalid children at root\.children/,
  );

  for (const invalidNode of [
    { kind: "element", type: "Screen", props: { extra: true }, children: [] },
    { kind: "element", type: "Text", props: { text: "ok", extra: true }, children: [] },
    { kind: "element", type: "Button", props: { label: "ok", action: "go", extra: true }, children: [] },
  ]) {
    assert.throws(
      () => compileProject({ root: (() => invalidNode) as unknown as () => UiNode }),
      /Invalid props at root\.props\.extra/,
    );
  }
});

test("rejects unexpected props on public container nodes", () => {
  for (const type of ["Screen", "View", "Fragment"] as const) {
    const node = {
      kind: "element",
      type,
      props: { unexpected: true },
      children: [],
    } as unknown as UiNode;

    assert.throws(
      () => compileProject({ root: (() => node) as unknown as () => UiNode }),
      new RegExp(`Invalid props at root\\.props\\.unexpected`),
    );
  }
});
