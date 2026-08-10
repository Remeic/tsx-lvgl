import {
  Button,
  Fragment,
  Screen,
  Text,
  View,
  createApplicationFacade,
} from "@tsx-lvgl/core";
export type { Component, VNode, VNodeChild } from "@tsx-lvgl/core";

import {
  useEffect,
  useInterval,
  useState,
} from "@tsx-lvgl/runtime";
export type { StateSetter } from "@tsx-lvgl/runtime";

import {
  isShake,
} from "@tsx-lvgl/sensors";
export type { MotionSample, SensorSample, SensorStatus } from "@tsx-lvgl/sensors";

import { useSensor } from "@tsx-lvgl/runtime";
import { motionSchema, type MotionSample, type SensorSample } from "@tsx-lvgl/sensors";

/** The supported high-level sensor hook; applications do not need the sensor workspace. */
function useMotionImplementation(): SensorSample<MotionSample> | undefined {
  return useSensor(motionSchema);
}

// The device resolver builds this same descriptor. Export through it so the
// parity test guards both runtime module resolution and the public SDK facade.
const applicationFacade = createApplicationFacade({
  Button,
  Fragment,
  Screen,
  Text,
  View,
  isShake,
  useEffect,
  useInterval,
  useMotion: useMotionImplementation,
  useState,
}) as Readonly<{
  Button: typeof Button;
  Fragment: typeof Fragment;
  Screen: typeof Screen;
  Text: typeof Text;
  View: typeof View;
  isShake: typeof isShake;
  useEffect: typeof useEffect;
  useInterval: typeof useInterval;
  useMotion: typeof useMotionImplementation;
  useState: typeof useState;
}>;

const {
  Button: FacadeButton,
  Fragment: FacadeFragment,
  Screen: FacadeScreen,
  Text: FacadeText,
  View: FacadeView,
  isShake: facadeIsShake,
  useEffect: facadeUseEffect,
  useInterval: facadeUseInterval,
  useMotion: facadeUseMotion,
  useState: facadeUseState,
} = applicationFacade;

export {
  FacadeButton as Button,
  FacadeFragment as Fragment,
  FacadeScreen as Screen,
  FacadeText as Text,
  FacadeView as View,
  facadeIsShake as isShake,
  facadeUseEffect as useEffect,
  facadeUseInterval as useInterval,
  facadeUseMotion as useMotion,
  facadeUseState as useState,
};
