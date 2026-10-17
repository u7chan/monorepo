import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { FileSkillList } from "../src/components/skill-settings/FileSkillList";
import type { FileSkillsState } from "../src/hooks/useFileSkills";
import {
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_LOADING_NOTE,
  SKILL_EXPORT_LABEL,
  SKILL_IMPORT_LABEL,
} from "../src/lib/fileSkills";
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

function render(state: FileSkillsState, selectedRelativePath?: string): string {
  return renderToStaticMarkup(
    createElement(FileSkillList, { state, selectedRelativePath, onReload: () => {}, onSelect: () => {} }),
  );
}

test("同名スキルもパスで選択を区別し、操作名に説明やパスを含めない", () => {
  const html = render({ status: "ready", skills: [common, builtin] }, builtin.relativePath);
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

function renderWithArchive(exporting: boolean, importing: boolean): string {
  return renderToStaticMarkup(
    createElement(FileSkillList, {
      state: { status: "ready", skills: [common] },
      onReload: () => {},
      onSelect: () => {},
      archive: { exporting, importing, onExport: () => {}, onImportFile: () => {} },
    }),
  );
}

/** メニュー項目ではなく、押せる操作として出ているか (状態の行と文言が重なっても区別できる) */
function hasButton(html: string, label: string): boolean {
  return new RegExp(`<button[^>]*>${label}</button>`).test(html);
}

test("持ち出し / 取り込みは一覧に渡したときだけ見出しに出し、送信中は押せない", () => {
  const ready = render({ status: "ready", skills: [common] });
  assert.ok(!hasButton(ready, SKILL_EXPORT_LABEL), "archive を渡していないのに持ち出しが出ている");
  assert.ok(!hasButton(ready, SKILL_IMPORT_LABEL), "archive を渡していないのに取り込みが出ている");

  const idle = renderWithArchive(false, false);
  assert.ok(hasButton(idle, SKILL_EXPORT_LABEL));
  assert.ok(hasButton(idle, SKILL_IMPORT_LABEL));
  assert.match(idle, /<input[^>]*type="file"[^>]*accept="\.zip,application\/zip"/);

  const busy = renderWithArchive(true, true);
  assert.match(busy, new RegExp(`<button[^>]*disabled=""[^>]*>${SKILL_EXPORT_LABEL}</button>`));
  assert.match(busy, new RegExp(`<button[^>]*disabled=""[^>]*>${SKILL_IMPORT_LABEL}</button>`));
});
