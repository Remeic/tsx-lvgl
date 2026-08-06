import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileProject, SourceCompileError } from "@tsx-lvgl/compiler";

const header = `/** @jsxImportSource @tsx-lvgl/react */
import { Button, Fragment, Screen, Text, View, useState } from "@tsx-lvgl/react";
`;

async function withSource(source: string, callback: (entryFile: string) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "tsx-lvgl-feature-test-"));
  const entryFile = join(directory, "entry.tsx");
  await writeFile(entryFile, source, "utf8");
  try {
    await callback(entryFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function compile(body: string): Promise<string> {
  let output = "";
  await withSource(`${header}\n${body}\n`, (entryFile) => {
    output = compileProject({ entryFile }).files["generated/ui.c"] ?? "";
  });
  return output;
}

async function expectDetail(body: string, detail: RegExp): Promise<void> {
  await withSource(`${header}\n${body}\n`, (entryFile) => {
    assert.throws(
      () => compileProject({ entryFile }),
      (error: unknown) => {
        assert.ok(error instanceof SourceCompileError);
        assert.match(error.message, detail);
        return true;
      },
    );
  });
}

test("lowers a state-driven ternary to two pre-built branches toggled by a hidden flag", async () => {
  const c = await compile(`
function App() {
  const [count, setCount] = useState(0);
  return <Screen>{count > 0 ? <Text text="on" /> : <Text text="off" />}<Button label="+" onClick={() => setCount((previous) => previous + 1)} /></Screen>;
}
export default App;`);
  // both branches are created once
  assert.match(c, /lv_label_set_text\(root_0_t_0, "on"\)/);
  assert.match(c, /lv_label_set_text\(root_0_f_0, "off"\)/);
  // visibility follows the int32 predicate and toggles the hidden flag both ways
  assert.match(c, /static void tsx_visibility_root_return_0\(void\)/);
  assert.match(c, /if \(\(\(tsx_state_root_s0\) > \(0\) \? 1 : 0\)\)/);
  assert.match(c, /lv_obj_remove_flag\(tsx_cond_root_return_0_t, LV_OBJ_FLAG_HIDDEN\)/);
  assert.match(c, /lv_obj_add_flag\(tsx_cond_root_return_0_f, LV_OBJ_FLAG_HIDDEN\)/);
  // the state update repaints the condition, and init runs it once
  assert.match(c, /tsx_update_root_s0\(void\)\n\{\n {4}tsx_visibility_root_return_0\(\);/);
});

test("lowers a logical-and conditional with only the true branch", async () => {
  const c = await compile(`
function App() {
  const [count, setCount] = useState(0);
  return <Screen>{count > 2 && <Text text="high" />}<Button label="+" onClick={() => setCount((previous) => previous + 1)} /></Screen>;
}
export default App;`);
  assert.match(c, /lv_label_set_text\(root_0_t_0, "high"\)/);
  assert.doesNotMatch(c, /tsx_cond_root_return_0_f/);
});

test("folds constant conditionals at compile time without a runtime toggle", async () => {
  const shown = await compile(`function App(){return <Screen>{true && <Text text="always" />}</Screen>;}export default App;`);
  assert.match(shown, /lv_label_set_text\(root_0, "always"\)/);
  assert.doesNotMatch(shown, /tsx_visibility/);

  const hidden = await compile(`function App(){return <Screen>{false && <Text text="never" />}<Text text="only" /></Screen>;}export default App;`);
  assert.doesNotMatch(hidden, /never/);
  // the folded-away branch emits no object; the sibling keeps its own index
  assert.match(hidden, /lv_label_set_text\(root_1, "only"\)/);
});

test("a folded-away conditional branch registers nothing (no dangling binding or dead handler)", async () => {
  // Regression: rendering both branches before folding leaked the discarded
  // branch's binding (a NULL label pointer -> segfault) and handler (dead
  // static -> -Werror). The constant-false branch must register nothing.
  const ternary = await compile(`
function App() {
  const [count, setCount] = useState(0);
  return <Screen>{false ? <Text text={count} /> : <Text text="zero" />}<Button label="+" onClick={() => setCount((previous) => previous + 1)} /></Screen>;
}
export default App;`);
  assert.match(ternary, /lv_label_set_text\(root_0, "zero"\)/);
  assert.doesNotMatch(ternary, /tsx_binding/);
  assert.doesNotMatch(ternary, /tsx_render/);

  const andHandler = await compile(`
function App() {
  const [count, setCount] = useState(0);
  return <Screen>{false && <Button label="dead" onClick={() => setCount(9)} />}<Button label="+" onClick={() => setCount((previous) => previous + 1)} /></Screen>;
}
export default App;`);
  // only the live "+" button's handler survives; the dead branch leaked none
  assert.equal((andHandler.match(/static void tsx_handler_/g) ?? []).length, 1);
  assert.doesNotMatch(andHandler, /"dead"/);
});

test("guards INT32_MIN with -1: division saturates to INT32_MAX, modulo yields 0", async () => {
  const c = await compile(`
function App() {
  const [count, setCount] = useState(-2147483648);
  return <Screen><Text text={count / -1} /><Text text={count % -1} /><Button label="x" onClick={() => setCount(1)} /></Screen>;
}
export default App;`);
  assert.match(c, /tsx_lvgl_guarded_div[\s\S]*?if \(current == INT32_MIN && divisor == -1\) return INT32_MAX;/);
  assert.match(c, /tsx_lvgl_guarded_mod[\s\S]*?if \(current == INT32_MIN && divisor == -1\) return 0;/);

  // the compile-time fold agrees with the guarded runtime helper
  const folded = await compile(`function App(){return <Screen><Text text={-2147483648 % -1} /></Screen>;}export default App;`);
  assert.match(folded, /lv_label_set_text\(root_0, "0"\)/);
});

test("lowers derived integer expressions to saturating int32 arithmetic in a live label", async () => {
  const c = await compile(`
function App() {
  const [count, setCount] = useState(1);
  return <Screen><Text text={count * count + 1} /><Button label="x" onClick={() => setCount((previous) => previous * 2)} /></Screen>;
}
export default App;`);
  assert.match(c, /tsx_lvgl_saturating_mul\(tsx_state_root_s0, tsx_state_root_s0\)/);
  assert.match(c, /tsx_lvgl_saturating_add\(tsx_lvgl_saturating_mul\(tsx_state_root_s0, tsx_state_root_s0\), 1\)/);
  // functional update reuses the same multiply helper
  assert.match(c, /tsx_state_root_s0 = tsx_lvgl_saturating_mul\(tsx_state_root_s0, 2\)/);
});

test("emits guarded division and modulo helpers", async () => {
  const c = await compile(`
function App() {
  const [count, setCount] = useState(10);
  return <Screen><Text text={count / 2} /><Text text={count % 3} /><Button label="x" onClick={() => setCount(1)} /></Screen>;
}
export default App;`);
  assert.match(c, /tsx_lvgl_guarded_div\(int32_t current, int32_t divisor\)/);
  assert.match(c, /tsx_lvgl_guarded_mod\(int32_t current, int32_t divisor\)/);
  assert.match(c, /if \(divisor == 0\) return 0;/);
  assert.match(c, /tsx_lvgl_guarded_div\(tsx_state_root_s0, 2\)/);
  assert.match(c, /tsx_lvgl_guarded_mod\(tsx_state_root_s0, 3\)/);
});

test("recomputes a label that depends on more than one state", async () => {
  const c = await compile(`
function App() {
  const [a, setA] = useState(1);
  const [b, setB] = useState(2);
  return <Screen>
    <Text text={a + b} />
    <Button label="a" onClick={() => setA((previous) => previous + 1)} />
    <Button label="b" onClick={() => setB((previous) => previous + 1)} />
  </Screen>;
}
export default App;`);
  assert.match(c, /snprintf\(.*"%ld", \(long\)\(tsx_lvgl_saturating_add\(tsx_state_root_s0, tsx_state_root_s1\)\)\)/);
  // both state updates repaint the shared binding
  assert.match(c, /tsx_update_root_s0\(void\)\n\{\n {4}tsx_render_root_s0_b0\(\);/);
  assert.match(c, /tsx_update_root_s1\(void\)\n\{\n {4}tsx_render_root_s0_b0\(\);/);
});

test("inlines component props: literals become constants and state props forward the caller slot", async () => {
  const c = await compile(`
function Labeled({ title, value }: { title: string; value: number }) {
  return <View><Text text={title} /><Text text={value} /></View>;
}
function App() {
  const [count, setCount] = useState(0);
  return <Screen>
    <Labeled title="static" value={42} />
    <Labeled title="live" value={count} />
    <Button label="+" onClick={() => setCount((previous) => previous + 1)} />
  </Screen>;
}
export default App;`);
  assert.match(c, /lv_label_set_text\(root_0_0, "static"\)/);
  assert.match(c, /lv_label_set_text\(root_0_1, "42"\)/);
  assert.match(c, /lv_label_set_text\(root_1_0, "live"\)/);
  // the state prop resolves to the caller's single state slot, rendered live
  assert.match(c, /tsx_binding_root_s0_b0 = root_1_1;/);
  assert.equal((c.match(/static int32_t tsx_state_/g) ?? []).length, 1);
});

test("rejects unsupported prop shapes with precise diagnostics", async () => {
  await expectDetail(
    `function Item({ value }: { value: number }){return <Text text={value} />;} function App(){return <Screen><Item /></Screen>;}export default App;`,
    /missing required prop value/,
  );
  await expectDetail(
    `function Item({ value }: { value: number }){return <Text text={value} />;} function App(){return <Screen><Item value={1} extra={2} /></Screen>;}export default App;`,
    /unknown prop extra for component Item/,
  );
  await expectDetail(
    `function Item(props: { value: number }){return <Text text={props.value} />;} function App(){return <Screen><Item value={1} /></Screen>;}export default App;`,
    /single destructured object parameter/,
  );
  await expectDetail(
    `function Item({ value }: { value: number }){return <Text text={value} />;} function App(){return <Screen><Item value /></Screen>;}export default App;`,
    /boolean props are unsupported/,
  );
});

test("unrolls an array-literal map into fixed children and feeds items into props", async () => {
  const c = await compile(`
function Row({ value }: { value: number }) {
  return <Text text={value} />;
}
function App() {
  return <Screen><View>{[10, 20, 30].map((value) => <Row value={value} />)}</View></Screen>;
}
export default App;`);
  assert.match(c, /lv_label_set_text\(root_0_0, "10"\)/);
  assert.match(c, /lv_label_set_text\(root_0_1, "20"\)/);
  assert.match(c, /lv_label_set_text\(root_0_2, "30"\)/);
  assert.equal((c.match(/lv_label_create/g) ?? []).length, 3);
});

test("exposes the list index parameter as a constant", async () => {
  const c = await compile(`
function App() {
  return <Screen><View>{["a", "b"].map((label, index) => <Text text={index} />)}</View></Screen>;
}
export default App;`);
  assert.match(c, /lv_label_set_text\(root_0_0, "0"\)/);
  assert.match(c, /lv_label_set_text\(root_0_1, "1"\)/);
});

test("rejects runtime-length lists and non-literal elements", async () => {
  await expectDetail(
    `function App(){return <Screen><View>{[1, 2, 3].filter((n) => n).map((n) => <Text text={n} />)}</View></Screen>;}export default App;`,
    /list source must be an inline array literal; runtime-length lists break the fixed tree/,
  );
  await expectDetail(
    `function App(){const [n, setN] = useState(0); return <Screen><View>{[n].map((value) => <Text text={value} />)}</View><Button label="x" onClick={() => setN(1)} /></Screen>;}export default App;`,
    /list elements must be integer or string literals/,
  );
});

test("folds compile-time string concatenation into a single literal", async () => {
  const c = await compile(`
function Tag({ name }: { name: string }) {
  return <Text text={"#" + name} />;
}
function App() { return <Screen><Tag name="one" /></Screen>; }
export default App;`);
  assert.match(c, /lv_label_set_text\(root_0, "#one"\)/);
});

test("reports sharp diagnostics for out-of-contract React APIs", async () => {
  for (const [api, feature] of [["useEffect", "effects"], ["useRef", "refs"], ["useContext", "context"], ["createContext", "context"]] as const) {
    await withSource(
      `/** @jsxImportSource @tsx-lvgl/react */\nimport { Screen, ${api} } from "@tsx-lvgl/react";\nfunction App(){return <Screen/>;}\nexport default App;\n`,
      (entryFile) => {
        assert.throws(
          () => compileProject({ entryFile }),
          new RegExp(`${api} is unsupported: ${feature} need a JavaScript runtime`),
        );
      },
    );
  }
});
