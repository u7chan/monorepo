import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SkillSelector } from "../src/components/agent-settings/SkillSelector";
import { DefinitionList } from "../src/components/DefinitionList";

test("カタログスキルは選択でき、組み込みはチェック済みの無効行として出す", () => {
  const html = renderToStaticMarkup(
    createElement(SkillSelector, {
      skills: [{ id: "catalog", name: "Catalog", description: "", body: "本文" }],
      builtinSkills: [{ name: "builtin", description: "" }],
      selectedIds: ["catalog"],
      onToggle: () => {},
    }),
  );
  const inputs = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0]);
  assert.equal(inputs.length, 2);
  assert.ok(inputs[0].includes('checked=""'));
  assert.ok(!inputs[0].includes('disabled=""'));
  assert.ok(inputs[1].includes('checked=""'));
  assert.ok(inputs[1].includes('disabled=""'));
  assert.ok(html.includes("割り当てを外すことはできません"));
});

test("定義一覧は件数がゼロのときだけ空状態を出す", () => {
  for (const count of [0, 1]) {
    const html = renderToStaticMarkup(
      createElement(DefinitionList, {
        title: "スキル一覧",
        count,
        addLabel: "追加",
        emptyLabel: "登録なし",
        onAdd: () => {},
        children: null,
      }),
    );
    assert.equal(html.includes("登録なし"), count === 0);
  }
});
