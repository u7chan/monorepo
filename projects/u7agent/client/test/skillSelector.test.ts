// エージェント編集のスキル欄 (組み込みの可視化) とスキル一覧の空状態を固定する。client に DOM テスト
// 基盤が無いため、fileSkillList.test.ts と同じくソース走査で「何を描画するか」だけを見る。
// ここが崩れると次のどれかになる。
//   1. 組み込みスキルがスキル欄に出ず、全エージェントで常時有効なことが分からない
//   2. 組み込み行が操作できるように見え、外せる / 外せないの区別が付かない
//   3. カタログのスキルが 0 件のとき、一覧が追加行だけで何も説明しない
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("スキル欄は組み込みをチェック済み・無効の行と注記で出す", () => {
  const source = read("src/components/agent-settings/SkillSelector.tsx");
  const mapAt = source.indexOf("builtinSkills.map");
  const noteAt = source.indexOf("{BUILTIN_SECTION_NOTE}");
  assert.ok(mapAt >= 0 && noteAt > mapAt, "組み込みセクションを切り出せない");
  const section = source.slice(mapAt, noteAt);

  assert.match(source, /組み込み（全エージェントで常時有効）/);
  for (const attribute of ["checked", "disabled", "readOnly"]) {
    assert.ok(section.includes(attribute), `組み込み行に ${attribute} が無い`);
  }
  assert.ok(section.includes("{skill.name}"), "組み込み行が名前を出してない");

  // カタログのスキルは従来どおり選べる (行ごと無効にしない)
  const catalogSection = source.slice(source.indexOf("skills.map"), mapAt);
  assert.ok(!catalogSection.includes("disabled"), "カタログの行まで無効になっている");
});

test("DefinitionList は count 0 のときだけ空状態の文言を出す", () => {
  const source = read("src/components/DefinitionList.tsx");
  assert.match(source, /count === 0 && emptyLabel/, "空状態の分岐が無い");
  assert.match(source, /\{emptyLabel\}/, "空状態の文言を描画してない");
  assert.match(source, /emptyLabel\?: string/, "emptyLabel が任意の prop になってない");
});

test("スキルページは空状態の文言を渡し、caption を本文の語に揃える", () => {
  const source = read("src/components/SkillSettingsPage.tsx");
  assert.match(source, /emptyLabel="カタログのスキルはまだありません/);
  assert.match(source, /caption="エージェントへ割り当てるスキルの本文を定義します/);
});

test("スキルのフォームは body を送り、ラベルも本文にする", () => {
  const source = read("src/components/skill-settings/SkillEditorForm.tsx");
  assert.match(source, /export type SkillForm = \{ name: string; description: string; body: string \}/);
  assert.match(source, /const payload = \{ name: form\.name, description: form\.description, body: form\.body \}/);
  assert.match(source, /value=\{form\.body\}/);
  assert.ok(source.includes("本文"), "本文ラベルが無い");
  assert.ok(!source.includes("form.prompt"), "旧フィールド prompt が残っている");
});

test("エージェント編集は組み込みスキルをスキル欄へ渡す", () => {
  const source = read("src/components/agent-settings/AgentEditorForm.tsx");
  assert.match(source, /builtinSkills=\{catalog\.builtinSkills\}/);
});
