import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compileProject } from "../packages/compiler/dist/index.js";
import { Button, Screen, Text } from "../packages/core/dist/index.js";

const outputPath = resolve("examples/esp-idf/tsx_lvgl_v1/main/tsx_generated_ui.c");

function BoardTracerBullet() {
  return Screen({
    children: [
      Text({ text: "TSX-LVGL V1" }),
      Text({ text: "SH8601 / FT3168" }),
      Button({ label: "Touch me", action: "touch_probe" }),
    ],
  });
}

const artifacts = compileProject({
  root: BoardTracerBullet,
  projectName: "tsx-lvgl-esp32-s3-v1",
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, artifacts.files["generated/ui.c"], "utf8");

console.log(`generated ${outputPath}`);
