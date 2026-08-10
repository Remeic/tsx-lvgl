/** @jsxImportSource @tsx-lvgl/core */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Screen, Text, type VNode } from "@tsx-lvgl/core";
import { useWifi } from "@tsx-lvgl/runtime";
import {
  MemoryWifiService,
  WIFI_MAX_PENDING_COMMANDS,
  type WifiController,
} from "@tsx-lvgl/connectivity";
import { BoardRuntime, MemoryBoardAdapter, NativeBoardWifiService, createDefaultBoardDescriptors, encodeBoardPayload, type NativeBoardRequest } from "@tsx-lvgl/device";
import { createHarness } from "./support/harness.js";

const context = { reloadEpoch: 1, isCancelled: () => false };

test("memory Wi-Fi station has bounded correlated operations and redacted diagnostics", () => {
  const wifi = new MemoryWifiService();
  const scan = wifi.scan({}, context);
  assert.equal(scan.id > 0, true);
  wifi.completeScan(scan.id, [
    { id: "weak", rssiDbm: -70, channel: 1, authKind: "wpa2" },
    { id: "strong", rssiDbm: -42, channel: 1, authKind: "wpa2" },
  ]);
  let networks: readonly { readonly id: string }[] = [];
  scan.subscribe((state) => { if (state.status === "succeeded") networks = state.value; });
  assert.deepEqual(networks.map((network) => network.id), ["strong", "weak"]);

  const connect = wifi.connect(context);
  assert.equal(wifi.getState().status, "ready");
  wifi.completeConnect(connect.id, { rssiDbm: -42, channel: 1, authKind: "wpa2" });
  assert.equal(JSON.stringify(wifi.diagnostics()).includes("ssid"), false);
  assert.equal(JSON.stringify(wifi.diagnostics()).includes("passphrase"), false);
  wifi.dispose();
});

test("memory Wi-Fi fences cancelled reloads and expires deterministic deadlines", () => {
  let now = 0;
  let cancelled = false;
  const wifi = new MemoryWifiService({ now: () => now, scanTimeoutMs: 10 });
  const scan = wifi.scan({}, { reloadEpoch: 7, isCancelled: () => cancelled });
  cancelled = true;
  wifi.completeScan(scan.id, []);
  let failure = "";
  scan.subscribe((state) => { if (state.status === "failed") failure = state.issue.code; });
  assert.equal(failure, "cancelled");
  const timed = wifi.scan({}, context);
  now = 10;
  wifi.expire();
  timed.subscribe((state) => { if (state.status === "failed") failure = state.issue.code; });
  assert.equal(failure, "timeout");
  wifi.dispose();
});

test("useWifi owns command cleanup while preserving the device station state", () => {
  const wifi = new MemoryWifiService();
  const { host, scheduler, runtime } = createHarness({ wifi });
  let controller: WifiController | undefined;
  function App(): VNode {
    controller = useWifi();
    return <Screen><Text text={`${controller.state.status}:${controller.connection.status}`} /></Screen>;
  }
  runtime.mount(<App />);
  assert.equal(host.text(), "ready:idle");
  const operationId = controller!.connect();
  assert.equal(controller!.connect.length, 0, "useWifi connect accepts no application credentials");
  scheduler.flush();
  assert.equal(controller!.connection.status, "running");
  runtime.unmount();
  const original = wifi.getOperation<void>(operationId);
  assert.equal(original.status, "failed");
  assert.equal(original.status === "failed" ? original.issue.code : "", "cancelled");
  let terminal = "";
  // The hook cleanup fences its in-flight command; the station service retains no credential data.
  const afterUnmount = wifi.connect(context);
  afterUnmount.subscribe((state) => { terminal = state.status; });
  assert.equal(operationId > 0, true);
  assert.equal(terminal, "running");
  wifi.dispose();
});

test("native Wi-Fi uses the single board queue, accepts no credentials, and fences cancelled commands", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const board = new BoardRuntime(adapter);
  const operation = board.wifi.connect(context);
  const command = adapter.submitted.at(-1);
  assert.deepEqual(command, { version: 1, kind: "command", instanceId: "wifi.station", commandId: "connect", correlationId: String(operation.id), reloadEpoch: 1 });
  assert.equal(JSON.stringify(command).includes("ssid"), false);
  assert.equal(JSON.stringify(command).includes("passphrase"), false);

  adapter.emit({
    version: 1, kind: "state", instanceId: "wifi.station", handle: 1, reloadEpoch: 1, sequence: 1, observedAtMs: 1,
    payload: encodeBoardPayload({ status: "ok", value: { phase: "connected", station: { rssiDbm: -42, channel: 1, authKind: "wpa2" } } }),
  });
  assert.equal(board.wifi.getState().status, "ready");
  adapter.emit({
    version: 1, kind: "operation", instanceId: "wifi.station", handle: 1, reloadEpoch: 1, sequence: 2, observedAtMs: 2,
    payload: encodeBoardPayload({ status: "succeeded", correlationId: String(operation.id) }),
  });
  let terminal = "";
  operation.subscribe((state) => { terminal = state.status; });
  assert.equal(terminal, "succeeded");

  const fenced = board.wifi.disconnect({ reloadEpoch: 2, isCancelled: () => true });
  fenced.subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  assert.equal(terminal, "cancelled");
  assert.equal(JSON.stringify(board.wifi.diagnostics()).includes("ssid"), false);
  board.dispose();
});

test("global Wi-Fi command budget returns a terminal resource-exhausted operation", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const board = new BoardRuntime(adapter);
  for (let index = 0; index < WIFI_MAX_PENDING_COMMANDS; index += 1) board.wifi.connect(context);

  let terminal = "";
  assert.doesNotThrow(() => board.wifi.connect(context).subscribe((state) => {
    terminal = state.status === "failed" ? state.issue.code : state.status;
  }));
  assert.equal(terminal, "resource-exhausted");
  assert.equal(board.wifi.diagnostics().pendingCommands, WIFI_MAX_PENDING_COMMANDS);
  board.dispose();
});

test("native Wi-Fi command deadline terminalizes a lost owner-queue event", () => {
  let now = 0;
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const wifi = new NativeBoardWifiService(adapter, { now: () => now, commandTimeoutMs: 10 });
  adapter.setSink((event) => wifi.accept(event));
  const operation = wifi.connect(context);
  now = 10;
  wifi.expire();
  let terminal = "";
  operation.subscribe((state) => { terminal = state.status === "failed" ? state.issue.code : state.status; });
  assert.equal(terminal, "timeout");
  assert.deepEqual(wifi.diagnostics().lastIssue, { code: "timeout", retry: "manual", diagnosticId: "wifi-command-timeout" });
  assert.equal(adapter.cancelled.length, 1);
  wifi.dispose();
});

test("native Wi-Fi queue-full rejection is observable and terminal", () => {
  class FullQueueAdapter extends MemoryBoardAdapter {
    public override submit(_request: NativeBoardRequest): number { throw new Error("board.submit: wifi-command-queue-full"); }
  }
  const wifi = new NativeBoardWifiService(new FullQueueAdapter({ descriptors: createDefaultBoardDescriptors() }));
  let terminal = "";
  assert.doesNotThrow(() => wifi.connect(context).subscribe((state) => {
    terminal = state.status === "failed" ? state.issue.code : state.status;
  }));
  assert.equal(terminal, "resource-exhausted");
  assert.deepEqual(wifi.diagnostics().lastIssue, { code: "resource-exhausted", retry: "never", diagnosticId: "wifi-command-queue-full" });
  wifi.dispose();
});
