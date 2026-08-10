/** @jsxImportSource @tsx-lvgl/core */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Screen, Text, type VNode } from "@tsx-lvgl/core";
import { useWifi } from "@tsx-lvgl/runtime";
import {
  MemoryWifiService,
  redactWifiConnectRequest,
  validateEphemeralWifiConnectRequest,
  type WifiController,
} from "@tsx-lvgl/connectivity";
import { BoardRuntime, MemoryBoardAdapter, createDefaultBoardDescriptors, encodeBoardPayload } from "@tsx-lvgl/device";
import { createHarness } from "./support/harness.js";

const context = { reloadEpoch: 1, isCancelled: () => false };

test("memory Wi-Fi station has bounded correlated operations and redacted diagnostics", () => {
  const wifi = new MemoryWifiService();
  const scan = wifi.scan({}, context);
  assert.equal(scan.id > 0, true);
  wifi.completeScan(scan.id, [
    { id: "weak", ssid: "lab", rssiDbm: -70, channel: 1, authKind: "wpa2" },
    { id: "strong", ssid: "lab", rssiDbm: -42, channel: 1, authKind: "wpa2" },
  ]);
  let networks: readonly { readonly id: string }[] = [];
  scan.subscribe((state) => { if (state.status === "succeeded") networks = state.value; });
  assert.deepEqual(networks.map((network) => network.id), ["strong", "weak"]);

  const request = { ssid: "private-lab", passphrase: testPassphrase() };
  assert.equal(validateEphemeralWifiConnectRequest(request), true);
  assert.deepEqual(redactWifiConnectRequest(request), { ssid: "<redacted>", passphrase: "<redacted>" });
  const connect = wifi.connect(request, context);
  assert.equal(wifi.getState().status, "ready");
  wifi.completeConnect(connect.id, { rssiDbm: -42, channel: 1, authKind: "wpa2" });
  assert.equal(JSON.stringify(wifi.diagnostics()).includes("private-lab"), false);
  assert.equal(JSON.stringify(wifi.diagnostics()).includes(request.passphrase), false);
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
  const operationId = controller!.connect({ ssid: "lab", passphrase: testPassphrase() });
  scheduler.flush();
  assert.equal(controller!.connection.status, "running");
  runtime.unmount();
  const original = wifi.getOperation<void>(operationId);
  assert.equal(original.status, "failed");
  assert.equal(original.status === "failed" ? original.issue.code : "", "cancelled");
  let terminal = "";
  // The hook cleanup fences its in-flight command; the station service retains no credential data.
  const afterUnmount = wifi.connect({ ssid: "lab", passphrase: testPassphrase() }, context);
  afterUnmount.subscribe((state) => { terminal = state.status; });
  assert.equal(operationId > 0, true);
  assert.equal(terminal, "running");
  wifi.dispose();
});

test("native Wi-Fi uses the single board queue, redacts credentials, and fences cancelled commands", () => {
  const adapter = new MemoryBoardAdapter({ descriptors: createDefaultBoardDescriptors() });
  const board = new BoardRuntime(adapter);
  const request = { ssid: "private-lab", passphrase: testPassphrase() };
  const operation = board.wifi.connect(request, context);
  const command = adapter.submitted.at(-1);
  assert.deepEqual(command, { version: 1, kind: "command", instanceId: "wifi.station", commandId: "connect", correlationId: String(operation.id), reloadEpoch: 1 });
  assert.equal(JSON.stringify(command).includes(request.ssid), false);
  assert.equal(JSON.stringify(command).includes(request.passphrase), false);

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
  assert.equal(JSON.stringify(board.wifi.diagnostics()).includes("private-lab"), false);
  board.dispose();
});

function testPassphrase(): string {
  // A generated fixture value keeps any credential literal out of source/evidence.
  return String.fromCharCode(120);
}
