export {
  Button,
  Fragment,
  Screen,
  Text,
  View,
  createVNode,
  isVNode,
  normalizeChildren,
  type Component,
  type ElementType,
  type Key,
  type VNode,
  type VNodeChild,
  type VNodeType,
  type WidgetProps,
} from "@tsx-lvgl/core";

export {
  useEffect,
  useInterval,
  useSensor,
  useState,
  type StateSetter,
} from "@tsx-lvgl/runtime";

export {
  isMotionSample,
  isShake,
  motionSchema,
  type MotionSample,
  type SensorSample,
  type SensorStatus,
} from "@tsx-lvgl/sensors";

import { useSensor } from "@tsx-lvgl/runtime";
import { motionSchema, type MotionSample, type SensorSample } from "@tsx-lvgl/sensors";

/** The supported high-level sensor hook; applications do not need the sensor workspace. */
export function useMotion(): SensorSample<MotionSample> | undefined {
  return useSensor(motionSchema);
}
