// 読み取り専用スキル一覧 (共通 + 組み込み) の行と再読み込みの形を固定する。client に DOM テスト基盤が
// 無いため、実際の accessible name は組み立てず、button が何を包むかで固定する (docs/api-catalog.md)。
// ここが崩れると次のどれかになる。
//   1. 名前行か button が説明・パス・警告を包み、行を選ぶたびに長文が読み上げられる
//   2. button を名前行へ絞った分だけクリック領域が狭まり、説明やパスを押しても本文ビューが開かない
//   3. 再読み込みが片方のグループの中へ戻り、押したときに何が更新されるのか読めなくなる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/** 一覧本体 (FileSkillList と、その行 / グループの定義) を切り出す */
function listSource(): string {
  const source = read("src/components/skill-settings/FileSkillList.tsx");
  const start = source.indexOf("export function FileSkillList");
  assert.ok(start >= 0, "FileSkillList を切り出せない");
  return source.slice(start);
}

type BuiltinRow = {
  /** 名前行の定義 (accessible name になる部分) */
  identity: string;
  /** 組み込み行 (本文ビューを開ける方) の button の中身 */
  button: string;
  /** button の後ろ (行の兄弟として置く説明・パス・警告) */
  afterButton: string;
  /** 組み込み行の分岐全体 (行の要素と button のクラスを見る) */
  row: string;
};

function builtinRow(source: string): BuiltinRow {
  const rowStart = source.indexOf("function FileSkillRow");
  const identityStart = source.indexOf("const identity = (", rowStart);
  const detailsStart = source.indexOf("const details = (", rowStart);
  const openStart = source.indexOf("if (!onOpen) {", rowStart);
  assert.ok(
    rowStart >= 0 && identityStart > rowStart && detailsStart > identityStart && openStart > detailsStart,
    "FileSkillRow の identity / details / 2 つの分岐を切り出せない",
  );
  const row = source.slice(openStart);
  const buttonStart = row.indexOf("<button");
  const buttonEnd = row.indexOf("</button>");
  assert.ok(buttonStart >= 0 && buttonEnd > buttonStart, "組み込み行の button を切り出せない");
  return {
    identity: source.slice(identityStart, detailsStart),
    button: row.slice(buttonStart, buttonEnd),
    afterButton: row.slice(buttonEnd),
    row,
  };
}

test("組み込み行の読み上げ名になるのは名前行だけで、説明・パス・警告は外へ出す", () => {
  const { identity, button, afterButton } = builtinRow(listSource());
  // 名前行と button の両方を見る (どちらかへ詳細を足すと accessible name が長文に戻る)
  for (const [where, part] of [
    ["名前行", identity],
    ["button", button],
  ] as const) {
    for (const detail of ["skill.description", "skill.relativePath", "warning"]) {
      assert.ok(!part.includes(detail), `${where}が ${detail} を包んでいる`);
    }
  }
  assert.match(identity, /\{skill\.name\}/, "名前行が名前を出してない");
  assert.ok(button.includes("{identity}"), "組み込み行の button が名前行を包んでない");
  assert.ok(afterButton.includes("{details}"), "説明・パス・警告が button の外に無い");
});

test("組み込み行のクリック領域は行全体のままにする", () => {
  const { button, row } = builtinRow(listSource());
  // 名前行だけを button にすると行のどこを押しても開かなくなるので、overlay で行全体を覆う
  assert.match(row, /["\s]relative[\s"]/, "組み込み行 (button の親) が relative でない");
  assert.ok(button.includes("after:absolute") && button.includes("after:inset-0"), "行全体を覆う overlay が無い");
  assert.match(button, /aria-pressed=\{selected\}/, "組み込み行の選択状態が読み上げられない");
});

test("再読み込みは共通と組み込みを包む見出しに置き、ラベルを視覚的にも出す", () => {
  const source = listSource();
  const headerStart = source.indexOf("flex items-center justify-between");
  const headingAt = source.indexOf("{FILE_SKILL_SECTION_LABEL}");
  const reloadAt = source.indexOf("aria-label={FILE_SKILL_RELOAD_ARIA_LABEL}");
  const groupAt = source.indexOf("<FileSkillGroup");
  assert.ok(headerStart >= 0 && headingAt > headerStart, "見出しがヘッダ行に無い");
  assert.ok(reloadAt > headingAt, "再読み込みが見出しの隣に無い");
  assert.ok(groupAt > reloadAt, "再読み込みが片方のグループの中にある");
  // アイコンだけだと何を更新するのか分からないので、読み上げ名と同じラベルを視覚的にも出す
  assert.ok(source.includes("{FILE_SKILL_RELOAD_LABEL}"), "再読み込みのラベルが視覚的に出ていない");
});

test("読み込み中 / 失敗の表示はグループの外に出す", () => {
  const source = listSource();
  const groupAt = source.indexOf("<FileSkillGroup");
  assert.ok(source.indexOf('{state.status === "loading"') < groupAt, "読み込み中の表示がグループの中にある");
  assert.ok(source.indexOf('{state.status === "error"') < groupAt, "失敗の表示がグループの中にある");
});
