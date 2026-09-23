// 読み取り専用スキルの選択 state の持ち方と、カタログスキルの閲覧 → 編集の遷移を固定する。client に DOM
// テスト基盤が無いため、実際の描画は組み立てず、選択の同一性と本文の取り直しの条件で固定する
// (docs/api-catalog.md)。ここが崩れると次のどれかになる。
//   1. 上書きされた組み込み (同名の共通行と並ぶ) を選ぶと、先に見つかった共通行の本文・版を出す
//   2. 共通スキルを開いたままファイルを編集し、同じ行を押し直しても古い本文が残る
//   3. 一覧で選んだだけで編集フォームが出る / 編集をキャンセルしても前の下書きが残る
//   4. 編集のたびに下書きを作り直さず、ファイルスキルへ移って戻ったときの旧下書きが復活する
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { AgentDef, SkillDef } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { CatalogSkillPanel } = await import("../src/components/skill-settings/CatalogSkillPanel");
const { skillFormDirty, skillFormOf } = await import("../src/components/skill-settings/SkillEditorForm");

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function pageSource(): string {
  return read("src/components/SkillSettingsPage.tsx");
}

function skill(overrides: Partial<SkillDef> = {}): SkillDef {
  return {
    id: "skill-review",
    name: "重要度順レビュー",
    description: "指摘を重要度順に並べる",
    body: "本文",
    ...overrides,
  };
}

function agent(id: string, name: string, skillIds: string[]): AgentDef {
  return { id, name, description: "", systemPrompt: "", skillIds };
}

test("選択は行固有の path で保持し、照合も path で行う", () => {
  const source = pageSource();
  assert.ok(source.includes("const [selectedFileSkillPath, setSelectedFileSkillPath]"), "選択を path で持っていない");
  assert.ok(
    source.includes(".find((skill) => skill.path === selectedFileSkillPath)"),
    "選択中の行の照合が path でない (同名の共通行と組み込み行を取り違える)",
  );
  assert.ok(source.includes("selectedPath={selectedFileSkillPath}"), "一覧へ選択中の path を渡していない");
});

test("同じ行を押し直しても本文を取り直す", () => {
  const source = pageSource();
  assert.ok(source.includes("setSelectedFileSkillSeq((seq) => seq + 1)"), "選択のたびに世代を進めていない");
  assert.ok(
    source.includes("key={`${selectedFileSkill.path}:${selectedFileSkillSeq}`}"),
    "本文ビューの key に選択の世代が入っていない (同じ行を押し直しても再取得されない)",
  );
});

test("カタログスキルは一覧で選ぶと閲覧ビュー、編集でフォームへ入る", () => {
  const source = pageSource();
  assert.match(source, /const \[mode, setMode\] = useState<SkillMode>\("view"\)/, "閲覧 / 編集の mode を持っていない");
  // 一覧の選択は閲覧ビューへ戻す (編集を抜ける唯一の入口)
  assert.match(
    source,
    /const selectSkill = \(nextId: string \| null\) => \{[^}]*setMode\("view"\)/,
    "選択で閲覧ビューへ戻していない",
  );
  assert.match(source, /const startNewSkill = \(\) => \{[^}]*setMode\("edit"\)/, "新規作成がフォームへ直行していない");
  assert.ok(source.includes('editingSkill && mode === "view" ? ('), "閲覧ビューの分岐が無い");
  assert.ok(source.includes("onEdit={startEditing}"), "閲覧ビューから編集を開始できない");
  assert.ok(
    source.includes("onCancel={editingSkill ? cancelEditing : undefined}"),
    "編集のキャンセルが編集フォームへ届いていない",
  );
});

test("編集の開始で下書きを作り直し、キャンセルで確認のうえ破棄する", () => {
  const source = pageSource();
  // 同じスキルで mode が view → edit に変わっても再初期化されるよう、初期化の条件に mode を入れる
  assert.ok(source.includes("formSource.mode !== mode"), "mode の変化で下書きを初期化していない");
  assert.ok(source.includes("setFormSource({ editingId, catalog, mode })"), "初期化の出所に mode を入れていない");
  assert.ok(
    source.includes("skillFormDirty(skillForm, editingSkill) && !window.confirm("),
    "未保存の差分があるときだけ確認していない",
  );
  assert.match(
    source,
    /const cancelEditing = \(\) => \{[^}]*setMode\("view"\)/,
    "キャンセルで閲覧ビューへ戻していない",
  );
});

test("compact のシート見出しは mode に連動する", () => {
  const source = pageSource();
  assert.ok(source.includes("title={sheetTitle}"), "シートの見出しに導出値を使っていない");
  for (const label of ['? "スキル"', ': "スキルを編集"', ': "新しいスキル"']) {
    assert.ok(source.includes(label), `${label} の分岐が無い`);
  }
});

test("下書きの差分は保存済みの内容と比べる", () => {
  const saved = skill();
  assert.equal(skillFormDirty(skillFormOf(saved), saved), false);
  assert.equal(skillFormDirty({ ...skillFormOf(saved), body: "直した" }, saved), true);
  assert.equal(skillFormDirty({ ...skillFormOf(saved), name: "改名" }, saved), true);
  assert.equal(skillFormDirty({ ...skillFormOf(saved), description: "説明を直した" }, saved), true);
  // 新規 (未保存) の下書きは空なら差分なし
  assert.equal(skillFormDirty(skillFormOf(undefined), undefined), false);
});

test("描画: 閲覧ビューは保存済みの本文と割り当て中のエージェントを出す", () => {
  const html = renderToStaticMarkup(
    createElement(CatalogSkillPanel, {
      skill: skill(),
      agents: [
        agent("agent-a", "コードレビュー", ["skill-review"]),
        agent("agent-b", "実装", ["skill-review", "skill-other"]),
      ],
      variant: "page",
      onEdit: () => {},
    }),
  );
  assert.ok(html.includes("割り当て中"), "割り当て中の行が無い");
  assert.ok(html.includes("2 件（コードレビュー、実装）"), "割り当て中の件数と名前が違う");
  assert.ok(html.includes("編集"), "編集の導線が無い");
  // 本文はカタログの応答をそのまま出す (編集中の下書きではない)
  assert.ok(html.includes("本文"), "本文が出ていない");
  assert.ok(html.includes("重要度順レビュー"), "名前が出ていない");
});

test("描画: 割り当てが 0 件でも件数を出す", () => {
  const html = renderToStaticMarkup(
    createElement(CatalogSkillPanel, {
      skill: skill(),
      agents: [agent("agent-a", "実装", [])],
      variant: "page",
      onEdit: () => {},
    }),
  );
  assert.ok(html.includes("0 件"), "0 件のとき件数を出していない");
});
