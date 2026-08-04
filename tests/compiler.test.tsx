/** @jsxImportSource @lume/core */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compileProject } from "@lume/compiler";
import { Button, Screen, Text, View, type UiNode } from "@lume/core";

function Counter(): UiNode {
  return (
    <Screen>
      <Text text={0} />
      <View>
        <Button label="+" action="increment" />
      </View>
    </Screen>
  );
}

test("compiles a TSX tree into deterministic LVGL C", () => {
  const first = compileProject({ root: Counter, projectName: "counter" });
  const second = compileProject({ root: Counter, projectName: "counter" });

  assert.deepEqual(first, second);
  assert.equal(first.manifest.target, "lvgl9-c");
  assert.match(first.files["generated/ui.c"] ?? "", /lv_label_set_text\(root_0, "0"\)/);
  assert.match(first.files["generated/ui.c"] ?? "", /lv_button_create\(root_1\)/);
  assert.match(first.files["generated/ui.c"] ?? "", /Lume action: increment/);
});

test("escapes C string literals", () => {
  function Escaped(): UiNode {
    return <Screen><Text text={'quote " and slash \\'} /></Screen>;
  }

  const result = compileProject({ root: Escaped });
  assert.match(result.files["generated/ui.c"] ?? "", /quote \\" and slash \\\\/);
});
