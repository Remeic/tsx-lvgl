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
  const directory = await mkdtemp(join(tmpdir(), "tsx-lvgl-source-diagnostic-test-"));
  const entryFile = join(directory, "entry.tsx");
  await writeFile(entryFile, source, "utf8");
  try {
    await callback(entryFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectDetail(source: string, detail: string, expectedLine?: number): Promise<void> {
  await withSource(`${header}\n${source}\n`, (entryFile) => {
    assert.throws(
      () => compileProject({ entryFile }),
      (error: unknown) => {
        assert.ok(error instanceof SourceCompileError);
        assert.equal(error.name, "SourceCompileError");
        assert.equal(error.code, "TSXL001");
        assert.ok(error.message.endsWith(`: ${detail}`), error.message);
        assert.ok(error.column >= 1);
        if (expectedLine !== undefined) assert.equal(error.line, expectedLine);
        return true;
      },
    );
  });
}

test("reports exact entry, import, component, and source-shape diagnostics", async () => {
  const cases: readonly [string, string][] = [
    [
      `function App(){return <Screen/>;}`,
      "entry file must have a default-exported root component",
    ],
    [
      `function App(){return <Screen/>;} export default Missing;`,
      "default export Missing is not a supported function component",
    ],
    [
      `function App(){return <View/>;} export default App;`,
      "default root must return <Screen>...</Screen>",
    ],
    [
      `export default function () { return <Screen/>; }`,
      "default function component must have a name",
    ],
    [
      `export = App; function App(){return <Screen/>;}`,
      "CommonJS export assignment is unsupported",
    ],
    [
      `export default 1;`,
      "default export must reference a function component",
    ],
    [
      `export { App }; function App(){return <Screen/>;}`,
      "module re-exports and namespaces are unsupported in the MVP",
    ],
    [
      `namespace App {} function Root(){return <Screen/>;} export default Root;`,
      "module re-exports and namespaces are unsupported in the MVP",
    ],
    [
      `class App {} function Root(){return <Screen/>;} export default Root;`,
      "unsupported top-level syntax; keep the entry file to imports, components, and a default export",
    ],
    [
      `const value = 1; function App(){return <Screen/>;} export default App;`,
      "unsupported top-level variable; only arrow function components are supported",
    ],
    [
      `import { Screen } from "other"; function App(){return <Screen/>;} export default App;`,
      "only @tsx-lvgl/react imports are supported",
    ],
    [
      `import React, { Screen } from "@tsx-lvgl/react"; function App(){return <Screen/>;} export default App;`,
      "default imports are unsupported; import named compatibility APIs",
    ],
    [
      `import * as React from "@tsx-lvgl/react"; function App(){return <Screen/>;} export default App;`,
      "namespace imports are unsupported; import named compatibility APIs",
    ],
    [
      `import { useMemo } from "@tsx-lvgl/react"; function App(){return <Screen/>;} export default App;`,
      "useMemo is unsupported: memoization hooks need a JavaScript runtime, which the fixed-tree native target does not include",
    ],
    [
      `import { unknownApi } from "@tsx-lvgl/react"; function App(){return <Screen/>;} export default App;`,
      "unsupported @tsx-lvgl/react import unknownApi",
    ],
    [
      `async function App(){return <Screen/>;} export default App;`,
      "async components are unsupported in the fixed-tree MVP",
    ],
    [
      `const App = async () => <Screen/>; export default App;`,
      "async components are unsupported in the fixed-tree MVP",
    ],
    [
      `function Child(props: unknown){return <Screen/>;} function App(){return <Screen><Child/></Screen>;} export default App;`,
      "component props must be a single destructured object parameter, for example ({ value })",
    ],
    [
      `function Tile(){return <Text>tile</Text>;} function App(){return <Screen><Tile><Text>lost</Text></Tile></Screen>;} export default App;`,
      "component children are unsupported in this MVP; compose zero-argument components",
    ],
    [
      `function App(){return <Screen><App/></Screen>;} export default App;`,
      "recursive component composition is unsupported (App)",
    ],
    [
      `const App = () => {}; export default App;`,
      "component must return a TSX element",
    ],
    [
      `function App(){return; } export default App;`,
      "component return must be a TSX element",
    ],
    [
      `function App(){return <Screen/>; return <Screen/>;} export default App;`,
      "component must have exactly one return statement",
    ],
    [
      `function App(){if (true) return <Screen/>; return <Screen/>;} export default App;`,
      "unsupported component syntax; only top-level useState declarations, local arrow handlers, and return are supported",
    ],
  ];
  for (const [source, detail] of cases) await expectDetail(source, detail);
});

test("anchors component-children diagnostics to the meaningful child", async () => {
  const source = `${header}
function Tile() {
  return <Text>tile</Text>;
}
function App() {
  return <Screen><Tile>
    <Text>lost</Text>
  </Tile></Screen>;
}
export default App;
`;
  await withSource(source, (entryFile) => {
    assert.throws(
      () => compileProject({ entryFile }),
      (error: unknown) => {
        assert.ok(error instanceof SourceCompileError);
        assert.equal(error.line, 9);
        assert.ok(error.column > 4);
        assert.match(error.message, /component children are unsupported/);
        return true;
      },
    );
  });
});

test("reports exact state, handler, and bounded-integer diagnostics", async () => {
  const cases: readonly [string, string][] = [
    [
      `function App(){let count = 0; return <Screen/>;} export default App;`,
      "component locals must be const declarations",
    ],
    [
      `function App(){const value = 1; return <Screen/>;} export default App;`,
      "unsupported component local; only useState destructuring and arrow event handlers are supported",
    ],
    [
      `function App(){const [count] = useState(0); return <Screen/>;} export default App;`,
      "useState must destructure exactly [state, setState]",
    ],
    [
      `function App(){const [count, {setCount}] = useState(0); return <Screen/>;} export default App;`,
      "useState must destructure exactly [state, setState]",
    ],
    [
      `function App(){const [count,setCount] = other(0); return <Screen/>;} export default App;`,
      "state declarations must be const [state, setState] = useState(integerLiteral)",
    ],
    [
      `function App(){const [count,setCount] = useState(); return <Screen/>;} export default App;`,
      "useState requires one signed 32-bit integer literal",
    ],
    [
      `function App(){const [count,setCount] = useState(value); return <Screen/>;} export default App;`,
      "useState initial value must be a signed 32-bit integer literal",
    ],
    [
      `function App(){const [count,setCount] = useState(1.5); return <Screen/>;} export default App;`,
      "useState initial value must be a signed 32-bit integer literal",
    ],
    [
      `function App(){const [count,setCount] = useState(2147483648); return <Screen/>;} export default App;`,
      "useState initial value must be a signed 32-bit integer literal",
    ],
    [
      `function App(){const [count,setCount] = useState(-2147483649); return <Screen/>;} export default App;`,
      "useState initial value must be a signed 32-bit integer literal",
    ],
    [
      `function App(){const [count,setCount] = useState(-value); return <Screen/>;} export default App;`,
      "useState initial value must be a signed 32-bit integer literal",
    ],
    [
      `function App(){const [count,setCount] = useState(0); const update = (event) => setCount(1); return <Screen><Button label="x" onClick={update}/></Screen>;} export default App;`,
      "event handlers cannot receive parameters",
    ],
    [
      `function App(){const [count,setCount] = useState(0); const update = () => count; return <Screen><Button label="x" onClick={update}/></Screen>;} export default App;`,
      "event handlers must call a local state setter",
    ],
    [
      `function App(){const [count,setCount] = useState(0); const update = () => { setCount(1); setCount(2); }; return <Screen><Button label="x" onClick={update}/></Screen>;} export default App;`,
      "event handler blocks must contain exactly one state-setter call",
    ],
    [
      `function App(){const [count,setCount] = useState(0); const update = () => setOther(1); return <Screen><Button label="x" onClick={update}/></Screen>;} export default App;`,
      "unknown state setter setOther",
    ],
    [
      `function App(){const [count,setCount] = useState(0); const update = () => setCount(); return <Screen><Button label="x" onClick={update}/></Screen>;} export default App;`,
      "state setters require exactly one update argument",
    ],
    [
      `function App(){const [count,setCount] = useState(0); const update = () => setCount(1, 2); return <Screen><Button label="x" onClick={update}/></Screen>;} export default App;`,
      "state setters require exactly one update argument",
    ],
    [
      `function App(){const [count,setCount] = useState(0); return <Screen><Button label="x" onClick={() => setCount("one")}/></Screen>;} export default App;`,
      "runtime string values are unsupported; only compile-time-constant strings are allowed",
    ],
    [
      `function App(){const [count,setCount] = useState(0); return <Screen><Button label="x" onClick={() => setCount((a,b) => a + 1)}/></Screen>;} export default App;`,
      "functional state updates require one previous-value parameter",
    ],
    [
      `function App(){const [count,setCount] = useState(0); return <Screen><Button label="x" onClick={() => setCount((previous) => missing + 1)}/></Screen>;} export default App;`,
      "unknown identifier missing in expression",
    ],
    [
      `function App(){const [count,setCount] = useState(0); return <Screen><Button label="x" onClick={() => setCount((previous) => previous + value)}/></Screen>;} export default App;`,
      "unknown identifier value in expression",
    ],
    [
      `function App(){const [count,setCount] = useState(0); return <Screen><Button label="x" onClick={() => setCount((previous) => previous ** 2)}/></Screen>;} export default App;`,
      "unsupported operator; use + - * / %, comparisons, or a state conditional",
    ],
    [
      `function App(){const [count,setCount] = useState(0); return <Screen><Button label="x" onClick={() => setCount((previous) => previous + 2147483648)}/></Screen>;} export default App;`,
      "integer literal must be a signed 32-bit integer literal",
    ],
    [
      `function App(){const [count,setCount] = useState(0); return <Screen><Button label="x" onClick={() => setCount(2147483648)}/></Screen>;} export default App;`,
      "state setter integer literal must be a signed 32-bit integer literal",
    ],
    [
      `function App(){const [count,setCount] = useState(0); return <Screen><Button label="x" onClick={() => setCount(-2147483649)}/></Screen>;} export default App;`,
      "state setter integer literal must be a signed 32-bit integer literal",
    ],
    [
      `function App(){const [count,setCount] = useState(0); return <Screen><Button label="x" onClick={() => setCount((previous) => previous + -2147483649)}/></Screen>;} export default App;`,
      "integer literal must be a signed 32-bit integer literal",
    ],
  ];
  for (const [source, detail] of cases) await expectDetail(source, detail);
});

test("reports exact JSX, layout, and handler diagnostics", async () => {
  const cases: readonly [string, string][] = [
    [
      `function App(){return <Screen bad="x"/>;} export default App;`,
      "Screen does not accept props in this MVP",
    ],
    [
      `function App(){return <Fragment bad="x"/>;} export default App;`,
      "Fragment does not accept props in this MVP",
    ],
    [
      `function App(){return <Screen><View direction="diagonal"/></Screen>;} export default App;`,
      "direction must be one of row, column",
    ],
    [
      `function App(){return <Screen><View align="diagonal"/></Screen>;} export default App;`,
      "align must be one of start, center, end",
    ],
    [
      `function App(){return <Screen><View gap="8"/></Screen>;} export default App;`,
      "gap must be a non-negative signed 32-bit integer literal",
    ],
    [
      `function App(){return <Screen><View direction/></Screen>;} export default App;`,
      "attribute requires a string literal",
    ],
    [
      `function App(){return <Screen><View direction={value}/></Screen>;} export default App;`,
      "attribute requires a string literal",
    ],
    [
      `function App(){return <Screen><View unknown={1}/></Screen>;} export default App;`,
      "unsupported unknown prop",
    ],
    [
      `function App(){return <Screen><View {...{}}/></Screen>;} export default App;`,
      "spread JSX attributes are unsupported",
    ],
    [
      `function App(){return <Screen><Text text="one">two</Text></Screen>;} export default App;`,
      "Text accepts either text= or one direct child, not both",
    ],
    [
      `function App(){return <Screen><Text>{1}{2}</Text></Screen>;} export default App;`,
      "Text requires a direct string, integer, or state binding",
    ],
    [
      `function App(){return <Screen><Text>   </Text></Screen>;} export default App;`,
      "Text requires a direct string, integer, or state binding",
    ],
    [
      `function App(){return <Screen><Text text /></Screen>;} export default App;`,
      "text requires a string, integer, or state expression",
    ],
    [
      `function App(){return <Screen><Text text={true}/></Screen>;} export default App;`,
      "Text does not accept boolean values",
    ],
    [
      `function App(){return <Screen><Text><View/></Text></Screen>;} export default App;`,
      "Text child must be a direct integer, string, or state binding",
    ],
    [
      `function App(){return <Screen><Text text={unknown}/></Screen>;} export default App;`,
      "unknown identifier unknown in expression",
    ],
    [
      `function App(){return <Screen><Text text="one">two</Text></Screen>;} export default App;`,
      "Text accepts either text= or one direct child, not both",
    ],
    [
      `function App(){return <Screen><Button label="one">two</Button></Screen>;} export default App;`,
      "Button accepts either label= or one direct text child, not both",
    ],
    [
      `function App(){return <Screen><Button label={1} onClick={() => undefined}/></Screen>;} export default App;`,
      "attribute requires a string literal",
    ],
    [
      `function App(){return <Screen><Button>{count}</Button></Screen>;} export default App;`,
      "Button requires a label= string or one direct text child",
    ],
    [
      `function App(){const [count,setCount] = useState(0); return <Screen><Button onClick={() => setCount(1)}>   </Button></Screen>;} export default App;`,
      "Button requires a label= string or one direct text child",
    ],
    [
      `function App(){return <Screen><Button onClick={() => undefined}/></Screen>;} export default App;`,
      "Button requires a label= string or one direct text child",
    ],
    [
      `function App(){return <Screen><Button label="x"/></Screen>;} export default App;`,
      "Button requires onClick={handler}",
    ],
    [
      `function App(){return <Screen><Button label="x" onClick/></Screen>;} export default App;`,
      "onClick must be an inline arrow or same-component local arrow function",
    ],
    [
      `function App(){return <Screen><Button label="x" onClick={count}/></Screen>;} export default App;`,
      "unknown local event handler count",
    ],
    [
      `function App(){return <Screen><Button label="x" onClick={doThing()}/></Screen>;} export default App;`,
      "onClick must be an inline arrow or same-component local arrow function",
    ],
    [
      `function App(){const [value,setValue] = useState(0); return <Screen><Button label="x" onClick={() => setValue(1)} extra="x"/></Screen>;} export default App;`,
      "unsupported extra prop",
    ],
    [
      `function App(){return <View/>;} export default App;`,
      "default root must return <Screen>...</Screen>",
    ],
    [
      `function App(){return <Screen>plain</Screen>;} export default App;`,
      "text children are only supported inside Text and Button",
    ],
    [
      `function App(){return <Screen>{1}</Screen>;} export default App;`,
      "expression children must be a state conditional ({cond && <X/>} or a ternary) or an array-literal .map(...)",
    ],
    [
      `function App(){return <Screen><Unknown/></Screen>;} export default App;`,
      "unknown component or intrinsic element Unknown",
    ],
    [
      `function Child(){return <Screen/>;} function App(){return <Screen><Child value={1}/></Screen>;} export default App;`,
      "component Child does not accept props",
    ],
  ];
  for (const [source, detail] of cases) await expectDetail(source, detail);
});

test("covers signed literal parsing, exact static text, and source positions", async () => {
  await withSource(
    `${header}\nfunction App(){\n  const [value,setValue] = useState(+1);\n  return <Screen><Text text={999999999999999999999999999999} /><Button label="x" onClick={() => setValue(-1)} /></Screen>;\n}\nexport default App;\n`,
    (entryFile) => {
      const result = compileProject({ entryFile });
      const c = result.files["generated/ui.c"] ?? "";
      assert.match(c, /tsx_state_root_s0 = 1/);
      assert.match(c, /lv_label_set_text\(root_0, "999999999999999999999999999999"\)/);
      assert.match(c, /tsx_state_root_s0 = -1/);
    },
  );
  await withSource(
    `${header}\nfunction App(){\n  const [value,setValue] = useState(-1);\n  return <Screen><Text text={-999999999999999999999999999999} /><Button label="x" onClick={() => setValue(+1)} /></Screen>;\n}\nexport default App;\n`,
    (entryFile) => {
      const result = compileProject({ entryFile });
      const c = result.files["generated/ui.c"] ?? "";
      assert.match(c, /tsx_state_root_s0 = -1/);
      assert.match(c, /lv_label_set_text\(root_0, "-999999999999999999999999999999"\)/);
      assert.match(c, /tsx_state_root_s0 = 1/);
    },
  );
  await expectDetail(
    `function App(){return <Screen><View gap={1.5}/></Screen>;} export default App;`,
    "gap must be a non-negative signed 32-bit integer literal",
  );
  await expectDetail(
    `function App(){const [value,setValue] = useState(0x10);return <Screen/>;} export default App;`,
    "useState initial value must be a signed 32-bit integer literal",
  );
  await withSource(
    `${header}\nfunction App(){\n  return <Screen><Text text="unterminated" /></Screen>\nexport default App;\n`,
    (entryFile) => {
      assert.throws(
        () => compileProject({ entryFile }),
        (error: unknown) => {
          assert.ok(error instanceof SourceCompileError);
          assert.equal(error.fileName, entryFile);
          assert.ok(error.line >= 2);
          assert.ok(error.column >= 1);
          assert.ok(error.message.length > entryFile.length);
          return true;
        },
      );
    },
  );
});

test("reports malformed TSX at a one-based source location", async () => {
  await withSource(
    `${header}
function App() {
  return <Screen><Text text="broken" /></Screen
}
export default App;
`,
    (entryFile) => {
      assert.throws(
        () => compileProject({ entryFile }),
        (error: unknown) => {
          assert.ok(error instanceof SourceCompileError);
          assert.equal(error.line, 6);
          assert.ok(error.column >= 1);
          assert.match(error.message, /TSX|JSX|expected/i);
          return true;
        },
      );
    },
  );
});
