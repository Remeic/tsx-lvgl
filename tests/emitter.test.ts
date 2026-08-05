import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emitLvgl } from "@tsx-lvgl/lvgl-emitter";

test("emits the legacy core tree deterministically", () => {
  const tree = {
    kind: "element" as const,
    type: "Screen" as const,
    props: {},
    children: [
      {
        kind: "element" as const,
        type: "View" as const,
        props: {},
        children: [
          { kind: "element" as const, type: "Text" as const, props: { text: "hello" }, children: [] },
          { kind: "element" as const, type: "Button" as const, props: { label: "go", action: "confirm" }, children: [] },
        ],
      },
    ],
  };
  const first = emitLvgl(tree);
  assert.equal(first, emitLvgl(tree));
  assert.match(first, /lv_obj_t \*root_0 = lv_obj_create\(root\);/);
  assert.match(first, /lv_label_set_text\(root_0_0, "hello"\)/);
  assert.match(first, /TSX-LVGL action: confirm/);
});

test("escapes legacy labels and action comments before C emission", () => {
  const output = emitLvgl({
    kind: "element",
    type: "Screen",
    props: {},
    children: [{
      kind: "element",
      type: "Button",
      props: { label: "quote\" slash\\ newline\n ?", action: "safe_action" },
      children: [],
    }],
  });
  assert.match(output, /quote\\" slash\\\\ newline\\n \\?/);
  assert.match(output, /TSX-LVGL action: safe_action/);
});

test("rejects malformed legacy nodes at the emitter boundary", () => {
  const cases: readonly [unknown, string][] = [
    [null, "Unsupported node at root"],
    [{ kind: "element", type: "Unknown", props: {}, children: [] }, "Unsupported node type at root.type"],
    [{ kind: "element", type: "Screen", props: null, children: [] }, "Invalid props at root.props"],
    [{ kind: "element", type: "Screen", props: {}, children: "bad" }, "Invalid children at root.children"],
    [{ kind: "element", type: "Screen", props: { extra: true }, children: [] }, "Invalid props at root.props.extra"],
    [{ kind: "element", type: "Text", props: {}, children: [] }, "Expected string or number at root.text"],
    [{ kind: "element", type: "Text", props: { text: {} }, children: [] }, "Expected string or number at root.text"],
    [{ kind: "element", type: "Text", props: { text: "ok" }, children: [{}] }, "Invalid child"],
    [{ kind: "element", type: "Text", props: { text: "ok" }, children: [{ kind: "element" }] }, "Invalid children at root.children"],
    [{ kind: "element", type: "Button", props: { label: "ok" }, children: [] }, "Expected string at root.action"],
    [{ kind: "element", type: "Button", props: { label: 1, action: "go" }, children: [] }, "Expected string at root.label"],
    [{ kind: "element", type: "Button", props: { label: "ok", action: "bad-id!" }, children: [] }, "Expected C identifier at root.action"],
    [{ kind: "element", type: "Button", props: { label: "ok", action: "go" }, children: [{ kind: "element" }] }, "Invalid children at root.children"],
  ];
  for (const [node, message] of cases) {
    assert.throws(() => emitLvgl(node as never), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("keeps React-only layout props out of the legacy emitter", () => {
  assert.throws(
    () => emitLvgl({
      kind: "element",
      type: "View",
      props: { direction: "row", gap: 8, onClick: () => undefined },
      children: [],
    } as never),
    /Invalid props at root\.props\.direction/,
  );
});
