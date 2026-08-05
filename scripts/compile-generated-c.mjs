import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compileProject } from "../packages/compiler/dist/index.js";
import { Button, Screen, Text } from "../packages/core/dist/index.js";
import { resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "tsx-lvgl-generated-c-"));
const sourcePath = join(directory, "ui.c");
const headerPath = join(directory, "lvgl.h");

try {
  const legacyArtifacts = compileProject({
    root: () => Screen({
      children: [
        Text({ text: "host compile" }),
        Text({ text: "trigraph ??/ ??= ??' ??( ??) ??! ??< ??> ??-" }),
        Button({ label: "ok", action: "confirm" }),
      ],
    }),
  });
  await writeFile(sourcePath, legacyArtifacts.files["generated/ui.c"], "utf8");
  await writeFile(
    headerPath,
    await readFile(new URL("../tests/fixtures/lvgl-host-stub.h", import.meta.url)),
  );

  const sourceArtifacts = compileProject({ entryFile: resolve("examples/counter.tsx"), projectName: "counter" });
  const sourcePathForMvp = join(directory, "mvp-ui.c");
  await writeFile(sourcePathForMvp, sourceArtifacts.files["generated/ui.c"], "utf8");

  const compiler = process.env.CC ?? "cc";
  for (const generatedPath of [sourcePath, sourcePathForMvp]) {
    const result = spawnSync(
      compiler,
      ["-std=c11", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-I", directory, generatedPath],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${compiler} rejected ${generatedPath} with exit code ${result.status}`);
    }
  }

  await runSaturatingRuntimeCheck({
    compiler,
    directory,
    source: `${sourceHeader()}
function LowerBound() {
  const [value, setValue] = useState(-2147483648);
  return <Screen><Text text={value} /><Button label="-" onClick={() => setValue((previous) => previous - 1)} /></Screen>;
}
export default LowerBound;
`,
    expected: -2147483648,
  });
  await runSaturatingRuntimeCheck({
    compiler,
    directory,
    source: `${sourceHeader()}
function UpperBound() {
  const [value, setValue] = useState(2147483647);
  return <Screen><Text text={value} /><Button label="+" onClick={() => setValue((previous) => previous + 1)} /></Screen>;
}
export default UpperBound;
`,
    expected: 2147483647,
  });
  await runInstanceIsolationRuntimeCheck({ compiler, directory });
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function runInstanceIsolationRuntimeCheck({ compiler, directory }) {
  const entryPath = join(directory, "instance-isolation.tsx");
  const generatedPath = join(directory, "instance-isolation.c");
  const runtimePath = join(directory, "instance-isolation-runtime.c");
  const harnessPath = join(directory, "instance-isolation.main.c");
  const executablePath = join(directory, "instance-isolation");
  await writeFile(
    entryPath,
    `${sourceHeader()}
function Counter() {
  const [value, setValue] = useState(0);
  return <View><Text text={value} /><Button label="+" onClick={() => setValue((previous) => previous + 1)} /></View>;
}
function App() { return <Screen><Counter /><Counter /></Screen>; }
export default App;
`,
    "utf8",
  );
  const artifacts = compileProject({ entryFile: entryPath });
  await writeFile(generatedPath, artifacts.files["generated/ui.c"], "utf8");
  await writeFile(runtimePath, runtimeStub(), "utf8");
  await writeFile(
    harnessPath,
    `#include <string.h>
void tsx_lvgl_ui_create(void);
int test_button_count(void);
const char *test_label_text_at(int index);
void test_click_button(int index);
int main(void) {
    tsx_lvgl_ui_create();
    if (test_button_count() != 2) return 1;
    if (strcmp(test_label_text_at(0), "0") != 0 || strcmp(test_label_text_at(2), "0") != 0) return 2;
    test_click_button(1);
    if (strcmp(test_label_text_at(0), "0") != 0 || strcmp(test_label_text_at(2), "1") != 0) return 3;
    test_click_button(0);
    if (strcmp(test_label_text_at(0), "1") != 0 || strcmp(test_label_text_at(2), "1") != 0) return 4;
    return 0;
}
`,
    "utf8",
  );
  const compileResult = spawnSync(
    compiler,
    ["-std=c11", "-Wall", "-Wextra", "-Werror", "-I", directory, generatedPath, runtimePath, harnessPath, "-o", executablePath],
    { stdio: "inherit" },
  );
  if (compileResult.error) throw compileResult.error;
  if (compileResult.status !== 0) throw new Error(`${compiler} rejected instance isolation fixture`);
  const runResult = spawnSync(executablePath, { stdio: "inherit" });
  if (runResult.error) throw runResult.error;
  if (runResult.status !== 0) throw new Error(`instance isolation fixture exited with code ${runResult.status}`);
  console.log("native instance isolation passed: clicking one of two Counter instances changes only its label");
}

function sourceHeader() {
  return `/** @jsxImportSource @tsx-lvgl/react */
import { Button, Screen, Text, View, useState } from "@tsx-lvgl/react";
`;
}

async function runSaturatingRuntimeCheck({ compiler, directory, source, expected }) {
  const entryPath = join(directory, `saturation-${expected}.tsx`);
  const generatedPath = join(directory, `saturation-${expected}.c`);
  const runtimePath = join(directory, "lvgl-runtime.c");
  const harnessPath = join(directory, `saturation-${expected}.main.c`);
  const executablePath = join(directory, `saturation-${expected}`);
  await writeFile(entryPath, source, "utf8");
  const artifacts = compileProject({ entryFile: entryPath });
  await writeFile(generatedPath, artifacts.files["generated/ui.c"], "utf8");
  await writeFile(runtimePath, runtimeStub(), "utf8");
  await writeFile(
    harnessPath,
    `#include <stdint.h>
void tsx_lvgl_ui_create(void);
void tsx_lvgl_ui_test_click(void);
int32_t tsx_lvgl_ui_state_root_s0(void);
int main(void) {
    tsx_lvgl_ui_create();
    if (tsx_lvgl_ui_state_root_s0() != ${expected}) return 1;
    tsx_lvgl_ui_test_click();
    return tsx_lvgl_ui_state_root_s0() == ${expected} ? 0 : 2;
}
`,
    "utf8",
  );

  const compileResult = spawnSync(
    compiler,
    ["-std=c11", "-Wall", "-Wextra", "-Werror", "-DTSX_LVGL_TEST_HOOKS", "-I", directory, generatedPath, runtimePath, harnessPath, "-o", executablePath],
    { stdio: "inherit" },
  );
  if (compileResult.error) throw compileResult.error;
  if (compileResult.status !== 0) throw new Error(`${compiler} rejected saturating runtime fixture`);
  const runResult = spawnSync(executablePath, { stdio: "inherit" });
  if (runResult.error) throw runResult.error;
  if (runResult.status !== 0) throw new Error(`saturating runtime fixture exited with code ${runResult.status}`);
}

function runtimeStub() {
  return `#include "lvgl.h"
#include <stddef.h>

struct lv_event_t { lv_event_code_t code; };
struct lv_obj_t { void (*callback)(lv_event_t *); const char *text; };

static lv_obj_t root;
static lv_obj_t objects[16];
static lv_obj_t *buttons[8];
static lv_obj_t *labels[16];
static size_t object_count;
static size_t button_count;
static size_t label_count;

static lv_obj_t *new_object(void) {
    if (object_count >= 16U) return NULL;
    return &objects[object_count++];
}

lv_obj_t *lv_screen_active(void) { return &root; }
lv_obj_t *lv_obj_create(lv_obj_t *parent) { (void)parent; return new_object(); }
lv_obj_t *lv_label_create(lv_obj_t *parent) {
    (void)parent;
    lv_obj_t *label = new_object();
    if (label != NULL && label_count < 16U) labels[label_count++] = label;
    return label;
}
void lv_label_set_text(lv_obj_t *label, const char *text) { label->text = text; }
void lv_label_set_text_static(lv_obj_t *label, const char *text) { label->text = text; }
lv_obj_t *lv_button_create(lv_obj_t *parent) {
    (void)parent;
    lv_obj_t *button = new_object();
    if (button != NULL && button_count < 8U) buttons[button_count++] = button;
    return button;
}
void lv_obj_set_flex_flow(lv_obj_t *obj, int32_t flow) { (void)obj; (void)flow; }
void lv_obj_set_flex_align(lv_obj_t *obj, int32_t main_place, int32_t cross_place, int32_t track_place) {
    (void)obj; (void)main_place; (void)cross_place; (void)track_place;
}
void lv_obj_set_style_pad_all(lv_obj_t *obj, int32_t value, int32_t selector) {
    (void)obj; (void)value; (void)selector;
}
void lv_obj_set_style_pad_row(lv_obj_t *obj, int32_t value, int32_t selector) {
    (void)obj; (void)value; (void)selector;
}
void lv_obj_set_style_pad_column(lv_obj_t *obj, int32_t value, int32_t selector) {
    (void)obj; (void)value; (void)selector;
}
void lv_obj_add_event_cb(lv_obj_t *obj, void (*callback)(lv_event_t *), lv_event_code_t filter, void *user_data) {
    (void)filter; (void)user_data; obj->callback = callback;
}
lv_event_code_t lv_event_get_code(lv_event_t *event) { return event->code; }
void lv_obj_send_event(lv_obj_t *obj, lv_event_code_t event_code, void *param) {
    (void)param;
    lv_event_t event = { .code = event_code };
    if (obj->callback != NULL) obj->callback(&event);
}
int test_button_count(void) { return (int)button_count; }
const char *test_label_text_at(int index) {
    return (index >= 0 && (size_t)index < label_count && labels[index]->text != NULL) ? labels[index]->text : "";
}
void test_click_button(int index) {
    if (index >= 0 && (size_t)index < button_count) lv_obj_send_event(buttons[index], LV_EVENT_CLICKED, NULL);
}
`;
}
