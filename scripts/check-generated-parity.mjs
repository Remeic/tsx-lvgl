import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileProject } from "../packages/compiler/dist/index.js";

const simulatorPath = resolve(process.env.TSX_LVGL_SIMULATOR_GENERATED_C ?? "build/simulator-container/generated/ui.c");
const espIdfPath = resolve(process.env.TSX_LVGL_IDF_GENERATED_C ?? "apps/esp-idf-v1/build/tsx-lvgl-generated/ui.c");
const expected = Buffer.from(
  compileProject({ entryFile: resolve("examples/counter.tsx"), projectName: "counter" }).files["generated/ui.c"] ?? "",
  "utf8",
);
const [simulator, espIdf] = await Promise.all([readFile(simulatorPath), readFile(espIdfPath)]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

if (!simulator.equals(espIdf) || !simulator.equals(expected)) {
  console.error("generated ui.c parity failed");
  console.error(`source=${digest(expected)}`);
  console.error(`simulator=${digest(simulator)} ${simulatorPath}`);
  console.error(`esp-idf=${digest(espIdf)} ${espIdfPath}`);
  process.exit(1);
}

console.log(`generated ui.c parity passed: sha256=${digest(expected)}`);
console.log(`simulator=${simulatorPath}`);
console.log(`esp-idf=${espIdfPath}`);
