import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compileProject } from "../packages/compiler/dist/index.js";
import { Button, Screen, Text } from "../packages/core/dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "lume-generated-c-"));
const sourcePath = join(directory, "ui.c");
const headerPath = join(directory, "lvgl.h");

try {
  const artifacts = compileProject({
    root: () => Screen({
      children: [
        Text({ text: "host compile" }),
        Button({ label: "ok", action: "confirm" }),
      ],
    }),
  });
  await writeFile(sourcePath, artifacts.files["generated/ui.c"], "utf8");
  await writeFile(
    headerPath,
    await readFile(new URL("../tests/fixtures/lvgl-host-stub.h", import.meta.url)),
  );

  const compiler = process.env.CC ?? "cc";
  const result = spawnSync(
    compiler,
    ["-std=c11", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-I", directory, sourcePath],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${compiler} rejected generated/ui.c with exit code ${result.status}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
