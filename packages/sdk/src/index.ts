import {
  Button,
  Fragment,
  Screen,
  StyleSheet,
  Text,
  View,
  createApplicationFacade,
} from "@tsx-lvgl/core";
export type { Component, VNode, VNodeChild } from "@tsx-lvgl/core";
export type { ViewStyle, TextStyle, ScreenStyle, StyleColor, StyleDim, StyleProp } from "@tsx-lvgl/core";

import {
  useEffect,
  useInterval,
  useMotion,
  useShake,
  useState,
  useWifi,
} from "@tsx-lvgl/runtime";
export type { ShakeState, StateSetter, UseShakeOptions } from "@tsx-lvgl/runtime";
export type { CapabilityBinding, CapabilityObserveOptions, CapabilityState } from "@tsx-lvgl/capabilities";
export type { WifiController, WifiLink, WifiNetwork, WifiScanRequest } from "@tsx-lvgl/connectivity";

import {
  isShake,
} from "@tsx-lvgl/sensors";
export type { MotionSample, ShakeThresholds } from "@tsx-lvgl/sensors";

// The device resolver builds this same descriptor. Export through it so the
// parity test guards both runtime module resolution and the public SDK facade.
const applicationFacade = createApplicationFacade({
  Button,
  Fragment,
  Screen,
  StyleSheet,
  Text,
  View,
  isShake,
  useEffect,
  useInterval,
  useMotion,
  useShake,
  useState,
  useWifi,
}) as Readonly<{
  Button: typeof Button;
  Fragment: typeof Fragment;
  Screen: typeof Screen;
  StyleSheet: typeof StyleSheet;
  Text: typeof Text;
  View: typeof View;
  isShake: typeof isShake;
  useEffect: typeof useEffect;
  useInterval: typeof useInterval;
  useMotion: typeof useMotion;
  useShake: typeof useShake;
  useState: typeof useState;
  useWifi: typeof useWifi;
}>;

const {
  Button: FacadeButton,
  Fragment: FacadeFragment,
  Screen: FacadeScreen,
  StyleSheet: FacadeStyleSheet,
  Text: FacadeText,
  View: FacadeView,
  isShake: facadeIsShake,
  useEffect: facadeUseEffect,
  useInterval: facadeUseInterval,
  useMotion: facadeUseMotion,
  useShake: facadeUseShake,
  useState: facadeUseState,
  useWifi: facadeUseWifi,
} = applicationFacade;

export {
  FacadeButton as Button,
  FacadeFragment as Fragment,
  FacadeScreen as Screen,
  FacadeStyleSheet as StyleSheet,
  FacadeText as Text,
  FacadeView as View,
  facadeIsShake as isShake,
  facadeUseEffect as useEffect,
  facadeUseInterval as useInterval,
  facadeUseMotion as useMotion,
  facadeUseShake as useShake,
  facadeUseState as useState,
  facadeUseWifi as useWifi,
};
