import assert from "node:assert/strict";
import test from "node:test";

import { compileTsxBundle } from "../packages/bundler/dist/index.js";
import { runHeadless } from "../packages/sdk/dist/headless.js";

test("headless SDK host renders a portable application bundle", async () => {
  const bundle = compileTsxBundle({
    fileName: "App.tsx",
    source: 'import { Screen, Text } from "@tsx-lvgl/sdk"; export default function App() { return <Screen><Text text="headless" /></Screen>; }',
    bundleId: "headless",
    boardId: "waveshare.esp32s3.touch-amoled-1.8",
    generation: 1,
    jsxImportSource: "@tsx-lvgl/sdk",
  });
  assert.deepEqual(
    await runHeadless({ manifest: bundle.manifest, source: bundle.bytes }, "waveshare.esp32s3.touch-amoled-1.8"),
    { texts: ["headless"], logs: [], generation: 1 },
  );
});
