// ファイルツリーのスクロール枠の内容幅を、あふれの有無 (スクロールバーの有無) に依存させない。
// client に DOM テスト基盤が無いため、FileBrowser のソース走査で「ガターが付く要素」を固定し、
// ガターのクラス定義は左バー (sidebarScrollGutter.test.ts) と同じく styles/index.css で固定する。
//   1. scrollbar-thin を持つツリーのスクロール枠が scrollbar-stable を持つ
//   2. その枠が overflow-y-auto である (縦に溢れたときにバーが出る枠)
//   3. ガターの定義が @layer components から外れる / both-edges になる / scrollbar-thin に混ざる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** ガターのクラス。定義は client/src/styles/index.css の @layer components */
const GUTTER = "scrollbar-stable";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/** FileBrowser の中で scrollbar-thin を持つクラス文字列 (ツリーのスクロール枠) */
function treeScrollFrameClasses(): string {
  const match = /"([^"]*scrollbar-thin[^"]*)"/.exec(read("src/components/FileBrowser.tsx"));
  assert.ok(match, "FileBrowser.tsx に scrollbar-thin を持つスクロール枠が無い");
  return match[1];
}

test("ツリーのスクロール枠はガターを持ち、縦スクロールの枠である", () => {
  const classes = treeScrollFrameClasses();
  assert.ok(classes.includes(GUTTER), "ツリーのスクロール枠にガターが無い");
  assert.ok(classes.includes("overflow-y-auto"), "ツリーのスクロール枠が縦スクロールの枠でない");
});

test("ガターは @layer components の専用クラスで、scrollbar-thin には混ざらない", () => {
  const css = read("src/styles/index.css");
  const layer = css.indexOf("@layer components");
  const definition = css.indexOf(`.${GUTTER} {`);
  assert.ok(layer >= 0, "@layer components が無い");
  assert.ok(definition > layer, `.${GUTTER} が @layer components の外にある`);

  const block = css.slice(definition, css.indexOf("}", definition));
  assert.ok(block.includes("scrollbar-gutter: stable;"), `.${GUTTER} が scrollbar-gutter: stable でない`);
  // both-edges は左にもガターが付き、行の左端 (インデント) が動く
  assert.ok(!block.includes("both-edges"), "both-edges が付いている");
  // scrollbar-thin は他画面 (設定の一覧 / ChatArea) とも共有するので巻き込まない
  assert.ok(!/\.scrollbar-thin \{[^}]*scrollbar-gutter/.test(css), "scrollbar-thin にガターが混ざっている");
});
