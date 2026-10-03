import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { FileSkillList } from "../src/components/skill-settings/FileSkillList";
import type { FileSkillsState } from "../src/hooks/useFileSkills";
import { FILE_SKILL_LOADING_NOTE, FILE_SKILL_ERROR_PREFIX } from "../src/lib/fileSkills";
import type { FileSkillInfo } from "../src/types";

const common: FileSkillInfo = {
  name: "alpha",
  description: "詳細な説明",
  path: "/workspace/.agents/skills/alpha/SKILL.md",
  relativePath: ".agents/skills/alpha/SKILL.md",
  scope: "user",
  disableModelInvocation: false,
  shadowed: [],
  overridden: false,
};
const builtin: FileSkillInfo = {
  ...common,
  path: "/builtin/alpha/SKILL.md",
  relativePath: ".u7agent/builtin-skills/alpha/SKILL.md",
  scope: "builtin",
  overridden: true,
  body: "組み込み本文",
  version: "1",
};

function render(state: FileSkillsState, selectedPath?: string): string {
  return renderToStaticMarkup(
    createElement(FileSkillList, { state, selectedPath, onReload: () => {}, onSelect: () => {} }),
  );
}

test("同名スキルもパスで選択を区別し、操作名に説明やパスを含めない", () => {
  const html = render({ status: "ready", skills: [common, builtin] }, builtin.path);
  const rows = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row[1]),
    ["false", "true"],
  );
  for (const row of rows) {
    const name = row[2].replace(/<[^>]*>/g, "");
    assert.ok(name.includes("alpha"));
    assert.ok(!name.includes(common.description));
    assert.ok(!name.includes("SKILL.md"));
    assert.ok(!name.includes("上書き"));
  }
  assert.ok(html.includes(common.description));
  assert.ok(html.includes(builtin.relativePath));
  assert.match(html, /aria-label="[^"]*再読み込み[^"]*"/);
});

test("取得中と失敗時は状態を表示し、以前のスキル行は出さない", () => {
  const loading = render({ status: "loading" });
  assert.ok(loading.includes(FILE_SKILL_LOADING_NOTE));
  assert.ok(!loading.includes("aria-pressed"));
  const failed = render({ status: "error", message: "読み取りに失敗" });
  assert.ok(failed.includes(FILE_SKILL_ERROR_PREFIX));
  assert.ok(failed.includes("読み取りに失敗"));
  assert.ok(!failed.includes("aria-pressed"));
});
