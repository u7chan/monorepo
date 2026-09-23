// 読み取り専用スキルの本文ビューの取得元と、本文 / ファイル のタブを固定する。client に DOM テスト基盤が
// 無いため、実際の描画は react-dom/server の静的な描画に留め、本文をどこから取るかとタブの出し分けで固定する
// (docs/api-catalog.md)。ここが崩れると次のどれかになる。
//   1. ファイルスキルの本文を一覧の応答から探し、一覧に無いので何も出ない
//   2. 選択を切り替えても前の本文を出し続ける (中断した要求の結果を反映する)
//   3. 組み込みの本文をファイルとして読みに行き、実体が無いので失敗する
//   4. ファイルタブを組み込みや root の外にも出し、ワークスペース root や別ディレクトリを見せる
//   5. ファイルタブへ行き来するたびに一覧を取り直す (display で保持せず unmount する)
//   6. 削除 / リネームの導線がファイルタブに残る
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { FileSkillInfo } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ReadOnlySkillPanel } = await import("../src/components/skill-settings/ReadOnlySkillPanel");

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function panelSource(): string {
  return read("src/components/skill-settings/ReadOnlySkillPanel.tsx");
}

function detailSource(): string {
  return read("src/components/skill-settings/SkillDetailPanel.tsx");
}

function fileSkill(overrides: Partial<FileSkillInfo> = {}): FileSkillInfo {
  return {
    name: "alpha",
    description: "アルファの説明",
    path: "/workspace/.agents/skills/alpha/SKILL.md",
    relativePath: ".agents/skills/alpha/SKILL.md",
    scope: "user",
    disableModelInvocation: false,
    shadowed: [],
    overridden: false,
    ...overrides,
  };
}

function renderPanel(skill: FileSkillInfo): string {
  return renderToStaticMarkup(createElement(ReadOnlySkillPanel, { skill, variant: "page" }));
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
  // 本文ブロックはカタログの閲覧ビューと共有する SkillDetailPanel が持つ
  const source = detailSource();
  for (const usage of ["{FILE_SKILL_BODY_LOADING_NOTE}", "{FILE_SKILL_BODY_ERROR_PREFIX}:"]) {
    assert.ok(source.includes(usage), `${usage} を出していない`);
  }
});

test("ページの見出しはスコープの名前 (共通 / プロジェクト / 組み込み) を使う", () => {
  const source = panelSource();
  assert.ok(source.includes("FILE_SKILL_PANEL_HEADING[skill.scope]"), "スコープの見出しを使っていない");
});

test("本文は表示と同じ生テキストを常時表示のコピーボタンでコピーする", () => {
  const source = detailSource();
  // 正規化した previewCopyText ではなく、表示中の pre と同じ本文を渡す (frontmatter 込み)
  assert.match(source, /copyMessage\(body\.text,/, "表示と違う本文をコピーしている");
  assert.ok(source.includes('label="本文をコピー"'), "押した結果が分かるラベルが無い");
  assert.ok(!source.includes("reveal="), "reveal を渡すと hover できる端末で隠れる");
});

test("ファイルタブは root 相対のスキルだけに出し、読み取り専用の FileBrowser を置く", () => {
  const source = panelSource();
  assert.ok(source.includes("fileSkillDir(skill)"), "ファイルタブの root を純関数で判定していない");
  assert.match(source, /<FileBrowser root=\{skillDir\} reloadToken=\{0\} readOnly \/>/, "FileBrowser の配線が違う");
  // 初回に開いたときだけ mount し、以降は display で隠して保持する
  assert.ok(source.includes('if (next === "files") setFilesOpened(true)'), "初回の mount をタブの選択で行っていない");
  assert.ok(source.includes('showFiles={tab === "files"}'), "表示の切替を display に渡していない");
  assert.ok(detailSource().includes('showFiles && "hidden"'), "本文を display で隠していない");
});

test("描画: ファイルタブは共通スキルに出し、組み込みには出さない", () => {
  const common = renderPanel(fileSkill());
  assert.ok(common.includes(">本文<"), "本文タブが無い");
  assert.ok(common.includes(">ファイル<"), "ファイルタブが無い");
  assert.ok(common.includes(".agents/skills/alpha/SKILL.md"), "置き場が出ていない");

  // 組み込みは実体が無い仮想パスなので、タブごと出さず本文だけを出す
  const builtin = renderPanel(
    fileSkill({
      scope: "builtin",
      relativePath: ".u7agent/builtin-skills/alpha/SKILL.md",
      body: "---\nname: alpha\n---\n本文\n",
      version: "1",
    }),
  );
  assert.ok(!builtin.includes(">ファイル<"), "組み込みにファイルタブが出ている");
  assert.ok(builtin.includes(">本文<"), "組み込みの本文が出ていない");
  assert.ok(builtin.includes("本文\n"), "組み込みの本文が一覧の応答と違う");
});
