/** @jsxImportSource @tsx-lvgl/core */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  Button,
  Fragment,
  Screen,
  Text,
  View,
  createVNode,
  isVNode,
  normalizeChildren,
  type Component,
  type VNode,
  type VNodeChild,
} from "@tsx-lvgl/core";
import { jsx as createJsx, jsxs as createJsxs } from "@tsx-lvgl/core/jsx-runtime";

test("Screen, View, Text, and Button are the string tag constants", () => {
  assert.equal(Screen, "Screen");
  assert.equal(View, "View");
  assert.equal(Text, "Text");
  assert.equal(Button, "Button");
});

test("a JSX intrinsic produces an element VNode typed by the string tag, not a wrapper function", () => {
  const vnode = <Text text="hi" />;
  assert.equal(vnode.kind, "element");
  assert.equal(vnode.type, "Text");
  assert.equal(vnode.type, Text);
  assert.equal(typeof vnode.type, "string");
});

test("JSX creates an immutable component VNode without invoking the component", () => {
  let renderCount = 0;
  function App(): VNode {
    renderCount += 1;
    return <Screen><Text text="ready" /></Screen>;
  }

  const vnode = <App />;

  assert.equal(vnode.kind, "component");
  assert.equal(renderCount, 0);
  assert.equal(Object.isFrozen(vnode), true);
  assert.equal(Object.isFrozen(vnode.props), true);
});

test("createVNode freezes the caller's props object in place instead of copying it", () => {
  const props = { text: "mutable-source" };
  const vnode = createVNode("Text", props);

  assert.equal(vnode.props, props, "the frozen props must be the same object identity, not a copy");
  assert.equal(Object.isFrozen(props), true);
  assert.throws(() => {
    (props as { text: string }).text = "changed";
  });
});

test("core normalizes children and validates every VNode identity field", () => {
  const child = <Text text="child" />;
  const component: Component = () => child;
  const normalized = normalizeChildren([[null, undefined, false, "hello", 42, child]]);

  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(normalizeChildren([]), normalizeChildren([]), "empty children use the shared immutable singleton");
  assert.deepEqual(normalized.map((value) => [value.type, value.props.text]), [
    ["Text", "hello"],
    ["Text", 42],
    ["Text", "child"],
  ]);
  assert.deepEqual(createVNode("Screen").children, []);
  assert.deepEqual(createVNode("Screen", null).props, {});
  assert.equal(createVNode(Fragment, {}, [child]).kind, "fragment");
  assert.equal(createVNode(component, {}, [child]).kind, "component");
  assert.equal("onClick" in createVNode(Button, { label: "plain" }).props, false);
  assert.throws(
    () => normalizeChildren([Symbol("invalid") as unknown as VNodeChild]),
    (error: unknown) => error instanceof Error && error.message === "Invalid child: expected a VNode, string, number, or empty value",
  );
});

test("isVNode validates kind/type pairing (including unknown element tags), keys, props, and children shape", () => {
  const component: Component = () => <Text text="x" />;
  const types: readonly unknown[] = ["Screen", component, Fragment, Symbol("other"), 42];
  const kinds = ["element", "component", "fragment", "unknown"] as const;
  for (const kind of kinds) {
    for (const type of types) {
      const candidate = { kind, type, key: null, props: {}, children: [] };
      const expected =
        (kind === "element" && type === "Screen") ||
        (kind === "component" && typeof type === "function") ||
        (kind === "fragment" && type === Fragment);
      assert.equal(isVNode(candidate), expected, `${kind}/${String(type)}`);
    }
  }

  // An element VNode naming a tag outside the declared vocabulary is invalid,
  // even though it otherwise has the right shape.
  assert.equal(isVNode({ kind: "element", type: "Nope", key: null, props: {}, children: [] }), false);

  const valid = { kind: "element", type: "Screen", key: null, props: {}, children: [] };
  assert.equal(isVNode({ ...valid, key: "string-key" }), true);
  assert.equal(isVNode({ ...valid, key: 7 }), true);
  assert.equal(isVNode({ ...valid, key: true }), false);
  assert.equal(isVNode({ ...valid, key: {} }), false);
  assert.equal(isVNode({ ...valid, props: null }), false);
  assert.equal(isVNode({ ...valid, props: 1 }), false);
  assert.equal(isVNode({ ...valid, children: "not-an-array" }), false);
  assert.equal(isVNode(null), false);
  assert.equal(isVNode(undefined), false);
  assert.equal(isVNode("not-a-vnode"), false);
});

test("the JSX runtime handles null props, scalar children, arrays, and keys", () => {
  const withoutProps = createJsx("Screen", null, undefined);
  assert.equal(withoutProps.key, null);
  assert.deepEqual(withoutProps.children, []);

  const scalar = createJsx("Text", { children: "scalar", text: "ignored" }, "text-key");
  assert.equal(scalar.key, "text-key");
  assert.deepEqual(scalar.children.map((child) => child.props.text), ["scalar"]);

  const array = createJsxs("View", { children: [<Text text="first" />, 2] }, 7);
  assert.equal(array.key, 7);
  assert.deepEqual(array.children.map((child) => child.props.text), ["first", 2]);
});
