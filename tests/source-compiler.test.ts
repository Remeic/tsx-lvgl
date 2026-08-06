import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileProject, SourceCompileError } from "@tsx-lvgl/compiler";

const header = `/** @jsxImportSource @tsx-lvgl/react */
import { Button, Screen, Text, View, useState } from "@tsx-lvgl/react";
`;

async function withSource(source: string, callback: (entryFile: string) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "tsx-lvgl-source-test-"));
  const entryFile = join(directory, "entry.tsx");
  await writeFile(entryFile, source, "utf8");
  try {
    await callback(entryFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("compiles the React-shaped counter source into deterministic native C", async () => {
  await withSource(
    `${header}
function Counter() {
  const [count, setCount] = useState(0);
  const increment = () => setCount((previous) => previous + 1);
  return <Screen><Text text={count} /><Button label="+" onClick={increment} /></Screen>;
}
export default Counter;
`,
    (entryFile) => {
      const first = compileProject({ entryFile, projectName: "counter" });
      const second = compileProject({ entryFile, projectName: "counter" });
      assert.deepEqual(first, second);
      assert.equal(first.manifest.compiler, "react-mvp-v0");
      assert.equal(first.manifest.lvgl, "9.5.0");
      assert.equal(first.manifest.projectName, "counter");
      const defaultArtifacts = compileProject({ entryFile });
      assert.equal(defaultArtifacts.manifest.projectName, "tsx-lvgl-project");
      assert.equal(
        defaultArtifacts.files["generated/manifest.json"],
        `${JSON.stringify(defaultArtifacts.manifest, null, 2)}\n`,
      );
      const c = first.files["generated/ui.c"] ?? "";
      assert.match(c, /tsx_state_root_s0 = 0/);
      assert.match(c, /tsx_lvgl_saturating_add\(tsx_state_root_s0, 1\)/);
      assert.match(c, /lv_label_set_text_static/);
      assert.match(c, /#ifdef TSX_LVGL_TEST_HOOKS[\s\S]*void tsx_lvgl_ui_test_click\(void\)/);
      assert.equal((c.match(/lv_button_create\(/g) ?? []).length, 1);
    },
  );
});

test("covers every compiler-private native emitter branch through source compilation", async () => {
  await withSource(
    `${header}
function App() {
  const [value, setValue] = useState(-2147483648);
  return <Screen><>
    <View direction="row" align="end" gap={8}>
      <Text text={value} />
      <Text text={"quote\\\" slash\\\\ backspace\\b formfeed\\f line\\n carriage\\r tab\\t vertical\\v question?"} />
      <Button label="set" onClick={() => setValue(2147483647)} />
      <Button label="plus" onClick={() => setValue((previous) => previous + 1)} />
      <Button label="minus" onClick={() => setValue((previous) => previous - 1)} />
    </View>
  </></Screen>;
}
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      const expected = [
        '#include "lvgl.h"',
        "#include <stdint.h>",
        "#include <stdio.h>",
        "static int32_t tsx_state_root_s0 = (-2147483647 - 1);",
        "static char tsx_binding_root_s0_b0_text[12];",
        "static lv_obj_t *tsx_binding_root_s0_b0 = NULL;",
        "static int32_t tsx_lvgl_saturating_add(int32_t current, int32_t delta)",
        "static int32_t tsx_lvgl_saturating_subtract(int32_t current, int32_t delta)",
        "static void tsx_update_root_s0(void)",
        "static void tsx_handler_root_a0(lv_event_t *event)",
        "static void tsx_handler_root_a1(lv_event_t *event)",
        "static void tsx_handler_root_a2(lv_event_t *event)",
        "tsx_state_root_s0 = 2147483647;",
        "tsx_state_root_s0 = tsx_lvgl_saturating_add(tsx_state_root_s0, 1);",
        "tsx_state_root_s0 = tsx_lvgl_saturating_subtract(tsx_state_root_s0, 1);",
        "lv_obj_set_flex_flow(root_0_0, LV_FLEX_FLOW_ROW);",
        "lv_obj_set_flex_align(root_0_0, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_END);",
        "lv_obj_set_style_pad_row(root_0_0, 8, 0);",
        "lv_obj_set_style_pad_column(root_0_0, 8, 0);",
        "tsx_binding_root_s0_b0 = root_0_0_0;",
        "lv_label_set_text(root_0_0_1, \"quote\\\" slash\\\\ backspace\\b formfeed\\f line\\n carriage\\r tab\\t vertical\\v question\\?\");",
        "lv_label_set_text(root_0_0_2_label, \"set\");",
        "lv_label_set_text(root_0_0_3_label, \"plus\");",
        "lv_label_set_text(root_0_0_4_label, \"minus\");",
        "lv_obj_add_event_cb(root_0_0_2, tsx_handler_root_a0, LV_EVENT_CLICKED, NULL);",
        "lv_obj_add_event_cb(root_0_0_3, tsx_handler_root_a1, LV_EVENT_CLICKED, NULL);",
        "lv_obj_add_event_cb(root_0_0_4, tsx_handler_root_a2, LV_EVENT_CLICKED, NULL);",
        "tsx_lvgl_test_button = root_0_0_2;",
        "tsx_lvgl_ui_test_click(void)",
        "int32_t tsx_lvgl_ui_state_root_s0(void)",
      ];
      for (const line of expected) assert.ok(c.includes(line), `missing generated line: ${line}`);
      assert.match(c, /static char tsx_binding_root_s0_b0_text\[12\];\nstatic lv_obj_t \*tsx_binding_root_s0_b0 = NULL;\n\nstatic int32_t/);
      assert.match(c, /#ifdef TSX_LVGL_TEST_HOOKS[\s\S]*tsx_lvgl_test_button = root_0_0_2;/);
    },
  );
});

test("keeps the compiler-private native C artifact exact across all emitted branches", async () => {
  await withSource(
    `${header}
function App() {
  const [value, setValue] = useState(-2147483648);
  return <Screen><View direction="row" align="end" gap={8}>
    <Text text={value} />
    <Text text={"quote\\\" slash\\\\ backspace\\b formfeed\\f line\\n carriage\\r tab\\t vertical\\v question?"} />
    <Text text={"control\\u0001delete\\u007f"} />
    <Button label="set" onClick={() => setValue(2147483647)} />
    <Button label="plus" onClick={() => setValue((previous) => previous + 1)} />
    <Button label="minus" onClick={() => setValue((previous) => previous - 1)} />
  </View></Screen>;
}
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.equal(c, String.raw`#include "lvgl.h"
#include <stdint.h>
#include <stdio.h>

static int32_t tsx_state_root_s0 = (-2147483647 - 1);
static char tsx_binding_root_s0_b0_text[12];
static lv_obj_t *tsx_binding_root_s0_b0 = NULL;

static int32_t tsx_lvgl_saturating_add(int32_t current, int32_t delta)
{
    const int64_t candidate = (int64_t)current + (int64_t)delta;
    if (candidate > INT32_MAX) return INT32_MAX;
    if (candidate < INT32_MIN) return INT32_MIN;
    return (int32_t)candidate;
}

static int32_t tsx_lvgl_saturating_subtract(int32_t current, int32_t delta)
{
    const int64_t candidate = (int64_t)current - (int64_t)delta;
    if (candidate > INT32_MAX) return INT32_MAX;
    if (candidate < INT32_MIN) return INT32_MIN;
    return (int32_t)candidate;
}

static void tsx_render_root_s0_b0(void)
{
    (void)snprintf(tsx_binding_root_s0_b0_text, sizeof(tsx_binding_root_s0_b0_text), "%ld", (long)(tsx_state_root_s0));
    lv_label_set_text_static(tsx_binding_root_s0_b0, tsx_binding_root_s0_b0_text);
}

static void tsx_update_root_s0(void)
{
    tsx_render_root_s0_b0();
}

static void tsx_handler_root_a0(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) return;
    tsx_state_root_s0 = 2147483647;
    tsx_update_root_s0();
}

static void tsx_handler_root_a1(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) return;
    tsx_state_root_s0 = tsx_lvgl_saturating_add(tsx_state_root_s0, 1);
    tsx_update_root_s0();
}

static void tsx_handler_root_a2(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) return;
    tsx_state_root_s0 = tsx_lvgl_saturating_subtract(tsx_state_root_s0, 1);
    tsx_update_root_s0();
}

#ifdef TSX_LVGL_TEST_HOOKS
static lv_obj_t *tsx_lvgl_test_button = NULL;
#endif

void tsx_lvgl_ui_create(void)
{
    lv_obj_t *root = lv_screen_active();
    lv_obj_set_flex_flow(root, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(root, 12, 0);
    lv_obj_t *root_0 = lv_obj_create(root);
    lv_obj_set_flex_flow(root_0, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(root_0, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_END);
    lv_obj_set_style_pad_row(root_0, 8, 0);
    lv_obj_set_style_pad_column(root_0, 8, 0);
    lv_obj_t *root_0_0 = lv_label_create(root_0);
    tsx_binding_root_s0_b0 = root_0_0;
    lv_obj_t *root_0_1 = lv_label_create(root_0);
    lv_label_set_text(root_0_1, "quote\" slash\\ backspace\b formfeed\f line\n carriage\r tab\t vertical\v question\?");
    lv_obj_t *root_0_2 = lv_label_create(root_0);
    lv_label_set_text(root_0_2, "control\001delete\177");
    lv_obj_t *root_0_3 = lv_button_create(root_0);
    lv_obj_t *root_0_3_label = lv_label_create(root_0_3);
    lv_label_set_text(root_0_3_label, "set");
    lv_obj_add_event_cb(root_0_3, tsx_handler_root_a0, LV_EVENT_CLICKED, NULL);
    #ifdef TSX_LVGL_TEST_HOOKS
    tsx_lvgl_test_button = root_0_3;
    #endif
    lv_obj_t *root_0_4 = lv_button_create(root_0);
    lv_obj_t *root_0_4_label = lv_label_create(root_0_4);
    lv_label_set_text(root_0_4_label, "plus");
    lv_obj_add_event_cb(root_0_4, tsx_handler_root_a1, LV_EVENT_CLICKED, NULL);
    lv_obj_t *root_0_5 = lv_button_create(root_0);
    lv_obj_t *root_0_5_label = lv_label_create(root_0_5);
    lv_label_set_text(root_0_5_label, "minus");
    lv_obj_add_event_cb(root_0_5, tsx_handler_root_a2, LV_EVENT_CLICKED, NULL);
    tsx_update_root_s0();
}

#ifdef TSX_LVGL_TEST_HOOKS
void tsx_lvgl_ui_test_click(void)
{
    if (tsx_lvgl_test_button != NULL) lv_obj_send_event(tsx_lvgl_test_button, LV_EVENT_CLICKED, NULL);
}
#endif

#ifdef TSX_LVGL_TEST_HOOKS
int32_t tsx_lvgl_ui_state_root_s0(void)
{
    return tsx_state_root_s0;
}

#endif

`);
    },
  );
});

test("omits optional state helpers when the source uses only literal text and set updates", async () => {
  await withSource(
    `${header}
function App() {
  const [value, setValue] = useState(0);
  return <Screen><Text text="static" /><Button label="set" onClick={() => setValue(1)} /></Screen>;
}
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.doesNotMatch(c, /tsx_lvgl_saturating_add/);
      assert.doesNotMatch(c, /tsx_lvgl_saturating_subtract/);
      assert.match(c, /tsx_state_root_s0 = 1;/);
    },
  );
});

test("preserves exact whitespace rules and signed 32-bit boundaries", async () => {
  await withSource(
    `${header}
function App() {
  const [low, setLow] = useState(-2147483648);
  const [high, setHigh] = useState(0);
  return <Screen>
    <View>
      <Text>
        padded
      </Text>
      <Button onClick={() => setLow(-2147483648)}>
        set-low
      </Button>
      <Button onClick={() => setHigh((previous) => previous + -2147483648)}>
        add-low
      </Button>
      <Button onClick={() => setHigh((previous) => previous + 2147483647)}>
        add-high
      </Button>
    </View>
  </Screen>;
}
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.match(c, /lv_label_set_text\(root_0_0, "padded"\)/);
      assert.match(c, /lv_label_set_text\(root_0_1_label, "set-low"\)/);
      assert.match(c, /tsx_state_root_s0 = \(-2147483647 - 1\);/);
      assert.match(c, /tsx_state_root_s1 = tsx_lvgl_saturating_add\(tsx_state_root_s1, \(-2147483647 - 1\)\);/);
      assert.match(c, /tsx_state_root_s1 = tsx_lvgl_saturating_add\(tsx_state_root_s1, 2147483647\);/);
    },
  );
});

test("accepts maximum gap and expression-form string literals", async () => {
  await withSource(
    `${header}
function App() {
  const [value, setValue] = useState(0);
  return <Screen>
    <View direction={"row"} gap={0}><Text text={"expression"} /></View>
    <View gap={2147483647} />
    <Button onClick={() => setValue(1)}>{"clicked"}</Button>
  </Screen>;
}
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.match(c, /lv_obj_set_flex_flow\(root_0, LV_FLEX_FLOW_ROW\)/);
      assert.match(c, /lv_obj_set_style_pad_row\(root_0, 0, 0\)/);
      assert.match(c, /lv_obj_set_style_pad_row\(root_1, 2147483647, 0\)/);
      assert.match(c, /lv_label_set_text\(root_0_0, "expression"\)/);
      assert.match(c, /lv_label_set_text\(root_2_label, "clicked"\)/);
    },
  );
});

test("covers arrow, default-function, parenthesized, and ignorable source forms", async () => {
  await withSource(
    `${header}
import type { ReactElement } from "@tsx-lvgl/react";
interface Props { readonly unused: number; }
type Alias = ReactElement;
const Tile = () => (<Text>tile</Text>);
export default function App() {
  return (<Screen><Tile /></Screen>);
}
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.match(c, /lv_label_set_text\(root_0, "tile"\)/);
    },
  );
});

test("allocates two-digit component paths and default arrow state paths deterministically", async () => {
  const counters = Array.from({ length: 11 }, () => "<Counter />").join("");
  await withSource(
    `${header}
function Counter() {
  const [count, setCount] = useState(0);
  return <View><Text text={count} /><Button label="+" onClick={() => setCount(1)} /></View>;
}
function App() { return <Screen>${counters}</Screen>; }
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.match(c, /tsx_state_root_return_10_c10_s0 = 0;/);
      assert.match(c, /tsx_binding_root_return_10_c10_s0_b0/);
    },
  );
  await withSource(
    `${header}
export default () => {
  const [value, setValue] = useState(0);
  return <Screen><Text text={value} /><Button label="set" onClick={() => setValue(1)} /></Screen>;
};
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.match(c, /tsx_state_root_s0 = 0;/);
    },
  );
});

test("emits a state-free program without state-only blank lines or helpers", async () => {
  await withSource(
    `${header}
function App() {
  return <Screen><Text text="x" /></Screen>;
}
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.equal(c, String.raw`#include "lvgl.h"
#include <stdint.h>
#include <stdio.h>

#ifdef TSX_LVGL_TEST_HOOKS
static lv_obj_t *tsx_lvgl_test_button = NULL;
#endif

void tsx_lvgl_ui_create(void)
{
    lv_obj_t *root = lv_screen_active();
    lv_obj_set_flex_flow(root, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(root, 12, 0);
    lv_obj_t *root_0 = lv_label_create(root);
    lv_label_set_text(root_0, "x");
}

#ifdef TSX_LVGL_TEST_HOOKS
#endif

`);
    },
  );
});

test("gives each fixed component instance an isolated state slot", async () => {
  await withSource(
    `${header}
function Counter() {
  const [count, setCount] = useState(0);
  return <View><Text>{count}</Text><Button onClick={() => setCount((previous) => previous + 1)}>+</Button></View>;
}
function App() { return <Screen><Counter /><Counter /></Screen>; }
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      const stateDeclarations = c.match(/static int32_t tsx_state_[A-Za-z0-9_]+ = 0;/g) ?? [];
      assert.equal(stateDeclarations.length, 2);
      assert.match(c, /root_return_0_c0_s0/);
      assert.match(c, /root_return_1_c1_s0/);
      assert.equal((c.match(/lv_button_create\(/g) ?? []).length, 2);
    },
  );
});

test("preserves hook order and emits saturating 32-bit updates", async () => {
  await withSource(
    `${header}
function Bounds() {
  const [low, setLow] = useState(-2147483648);
  const [high, setHigh] = useState(2147483647);
  return <Screen>
    <Text text={low} />
    <Text text={high} />
    <Button label="up" onClick={() => setHigh((previous) => previous + 1)} />
    <Button label="set" onClick={() => setLow(2147483647)} />
  </Screen>;
}
export default Bounds;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.match(c, /tsx_state_root_s0 = \(-2147483647 - 1\)/);
      assert.match(c, /tsx_state_root_s1 = 2147483647/);
      assert.match(c, /tsx_state_root_s1 = tsx_lvgl_saturating_add\(tsx_state_root_s1, 1\)/);
      assert.match(c, /tsx_state_root_s0 = 2147483647/);
      assert.equal((c.match(/static int32_t tsx_state_root_s[01]/g) ?? []).length, 2);
    },
  );
});

test("preserves exact decimal rendering for static Text integers outside int32", async () => {
  await withSource(
    `${header}
function App() {
  return <Screen>
    <Text text={2147483648} />
    <Text>{-2147483649}</Text>
    <Text text={999999999999999999999999999999} />
  </Screen>;
}
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.match(c, /lv_label_set_text\(root_0, "2147483648"\)/);
      assert.match(c, /lv_label_set_text\(root_1, "-2147483649"\)/);
      assert.match(c, /lv_label_set_text\(root_2, "999999999999999999999999999999"\)/);
      assert.doesNotMatch(c, /2147483647/);
    },
  );
});

test("lowers minimal View flex layout and subtraction handlers", async () => {
  await withSource(
    `${header}
function App() {
  const [count, setCount] = useState(2);
  return <Screen><View direction="row" align="center" gap={8}>
    <Text text={count} />
    <Button label="-" onClick={() => setCount((previous) => previous - 1)} />
  </View></Screen>;
}
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.match(c, /lv_obj_set_flex_flow\(root_0, LV_FLEX_FLOW_ROW\)/);
      assert.match(c, /lv_obj_set_flex_align\(root_0, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER\)/);
      assert.match(c, /lv_obj_set_style_pad_row\(root_0, 8, 0\)/);
      assert.match(c, /tsx_lvgl_saturating_subtract\(tsx_state_root_s0, 1\)/);
    },
  );
});

test("supports source fragments as transparent fixed-tree groups", async () => {
  await withSource(
    `${header}
import { Fragment } from "@tsx-lvgl/react";
function App() {
  return <Screen><Fragment><Text>explicit</Text></Fragment><><Text>inside</Text><Text text="fragment" /></></Screen>;
}
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.match(c, /lv_label_set_text\(root_0_0, "explicit"\)/);
      assert.match(c, /lv_label_set_text\(root_1_0, "inside"\)/);
      assert.match(c, /lv_label_set_text\(root_1_1, "fragment"\)/);
    },
  );
});

test("allows whitespace around zero-argument components but never drops meaningful children", async () => {
  await withSource(
    `${header}
function Tile() {
  return <Text>tile</Text>;
}
function App() {
  return <Screen><Tile>
${"    "}
  </Tile></Screen>;
}
export default App;
`,
    (entryFile) => {
      const c = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
      assert.match(c, /lv_label_set_text\(root_0, "tile"\)/);
    },
  );
});

test("rejects unsupported semantics with source-positioned diagnostics", async () => {
  await withSource(
    `${header}
function Invalid() {
  const [count, setCount] = useState(0);
  if (count > 0) setCount(1);
  return <Screen><Text text={count + 1} /></Screen>;
}
export default Invalid;
`,
    (entryFile) => {
      assert.throws(
        () => compileProject({ entryFile }),
        (error: unknown) => {
          assert.ok(error instanceof SourceCompileError);
          assert.equal(error.fileName, entryFile);
          assert.equal(error.line, 6);
          assert.ok(error.column >= 1);
          assert.match(error.message, /unsupported component syntax/);
          return true;
        },
      );
    },
  );
});

test("rejects invalid initial state, layout, hook ordering, and update syntax", async () => {
  const cases: readonly [string, RegExp][] = [
    [`function App(){const [count,setCount]=useState(2147483648);return <Screen/>;}export default App;`, /signed 32-bit integer literal/],
    [`function App(){return <Screen><View gap={-1}/></Screen>;}export default App;`, /gap must be a non-negative signed 32-bit integer literal/],
    [`function App(){return <Screen><View gap={2147483648}/></Screen>;}export default App;`, /gap must be a non-negative signed 32-bit integer literal/],
    [`function App(){const [count,setCount]=useState(0);const update=()=>setCount((previous)=>previous**2);return <Screen><Button label="x" onClick={update}/></Screen>;}export default App;`, /unsupported operator/],
    [`function App(){const [count,setCount]=useState(0);return <Screen><Button label="x" onClick={() => setCount(999999999999999999999999)}/></Screen>;}export default App;`, /state setter integer literal must be a signed 32-bit integer literal/],
    [`function App(){const [count,setCount]=useState(0);return <Screen><Button label="x" onClick={() => setCount((previous) => previous + 999999999999999999999999)}/></Screen>;}export default App;`, /integer literal must be a signed 32-bit integer literal/],
    [`function App(){const [count,setCount]=useState(0);return <Screen><Button label="x" onClick={() => setCount(~1)}/></Screen>;}export default App;`, /unsupported unary operator/],
    [`const value = 1; function App(){return <Screen/>;}export default App;`, /unsupported top-level variable/],
    [`function App(){const [count,setCount]=useState(0);return <Screen><Text text={count.value}/></Screen>;}export default App;`, /unsupported expression/],
  ];
  for (const [body, message] of cases) {
    await withSource(`${header}\n${body}\n`, (entryFile) => {
      assert.throws(() => compileProject({ entryFile }), message);
    });
  }
});

test("rejects async components and handlers at their source locations", async () => {
  const cases: readonly [string, RegExp][] = [
    [`async function App(){return <Screen/>;}export default App;`, /async components are unsupported/],
    [`function App(){const [count,setCount]=useState(0);return <Screen><Button label="x" onClick={async () => setCount(1)}/></Screen>;}export default App;`, /async event handlers are unsupported/],
    [`function App(){const [count,setCount]=useState(0);const update=async()=>setCount(1);return <Screen><Button label="x" onClick={update}/></Screen>;}export default App;`, /async event handlers are unsupported/],
    [`function App(){const [count,setCount]=useState(0);return <Screen><Button label="x" onClick={() => setCount(async (previous) => previous + 1)}/></Screen>;}export default App;`, /async state updates are unsupported/],
  ];
  for (const [body, message] of cases) {
    await withSource(`${header}\n${body}\n`, (entryFile) => {
      assert.throws(
        () => compileProject({ entryFile }),
        (error: unknown) => {
          assert.ok(error instanceof SourceCompileError);
          assert.equal(error.fileName, entryFile);
          assert.ok(error.line >= 2);
          assert.ok(error.column >= 1);
          assert.match(error.message, message);
          return true;
        },
      );
    });
  }
});

test("rejects missing compatibility imports and malformed TSX", async () => {
  await withSource(
    `function App(){return <Screen/>;}export default App;\n`,
    (entryFile) => assert.throws(() => compileProject({ entryFile }), /unknown component or intrinsic element Screen/),
  );
  await withSource(
    `${header}\nfunction App(){return <Screen><Text text="unterminated" /></Screen>\nexport default App;\n`,
    (entryFile) => assert.throws(() => compileProject({ entryFile }), SourceCompileError),
  );
});
