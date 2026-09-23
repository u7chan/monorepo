// 読み取り専用スキルの本文ビューの取得元を固定する。client に DOM テスト基盤が無いため、
// 実際の描画は組み立てず、本文をどこから取るかで固定する (docs/api-catalog.md)。
// ここが崩れると次のどれかになる。
//   1. ファイルスキルの本文を一覧の応答から探し、一覧に無いので何も出ない
//   2. 選択を切り替えても前の本文を出し続ける (中断した要求の結果を反映する)
//   3. 組み込みの本文をファイルとして読みに行き、実体が無いので失敗する
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function panelSource(): string {
  return readFileSync(
    fileURLToPath(new URL("../src/components/skill-settings/ReadOnlySkillPanel.tsx", import.meta.url)),
    "utf8",
  );
}

test("ファイルスキルの本文は選択のたびにファイルプレビューから取り直す", () => {
  const source = panelSource();
  assert.ok(source.includes("getFilePreview(skill.relativePath"), "本文をファイルプレビューから取っていない");
  assert.ok(source.includes("new AbortController()"), "選択の切り替えで取得を中断できない");
  assert.ok(source.includes("controller.abort()"), "取得の後始末で中断していない");
});

test("組み込みの本文は一覧の応答をそのまま使う", () => {
  const source = panelSource();
  assert.ok(source.includes("skill.body !== undefined"), "組み込みの本文を一覧の応答から取っていない");
  assert.ok(source.includes('setBody({ status: "ready", text: skill.body })'), "本文をそのまま出していない");
});

test("本文ビューは読み込み中と失敗を本文の代わりに出す", () => {
  const source = panelSource();
  for (const usage of ["{FILE_SKILL_BODY_LOADING_NOTE}", "{FILE_SKILL_BODY_ERROR_PREFIX}:"]) {
    assert.ok(source.includes(usage), `${usage} を出していない`);
  }
});

test("ページの見出しはスコープの名前 (共通 / プロジェクト / 組み込み) を使う", () => {
  const source = panelSource();
  assert.ok(source.includes("FILE_SKILL_PANEL_HEADING[skill.scope]"), "スコープの見出しを使っていない");
});
