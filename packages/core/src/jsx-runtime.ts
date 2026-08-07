import {
  createVNode,
  Fragment as FragmentType,
  type Component,
  type ElementType,
  type Key,
  type VNode,
  type VNodeChild,
  type VNodeType,
  type WidgetProps,
} from "./index.js";

export namespace JSX {
  export type Element = VNode;

  export interface ElementChildrenAttribute {
    children: {};
  }

  export interface IntrinsicAttributes {
    key?: Key;
  }

  /** Derived from the single vocabulary declaration in `@tsx-lvgl/core`. */
  export type IntrinsicElements = WidgetProps;
}

export const Fragment = FragmentType;

export function jsx(
  type: VNodeType,
  props: Readonly<Record<string, unknown>> | null,
  key: Key = null,
): VNode {
  if (props === null) return createVNode(type, null, undefined, key);
  const { children, ...elementProps } = props;
  return createVNode(type, elementProps, [children as VNodeChild], key);
}

export const jsxs = jsx;

export type { Component, ElementType };
