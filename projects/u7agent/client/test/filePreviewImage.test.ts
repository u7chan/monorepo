// 画像プレビューの下地 (市松) とパス行のメタ (寸法 · サイズ) を成立させている実装を突き合わせる。client に DOM
// テスト基盤が無く (FilePreview は api.ts 経由で location を読むため node で import できない)、見た目そのものは
// 手動確認に残すため、配線と CSS の定義をソース走査で固定する。どれかが崩れると次のどれかになる。
//   1. 透過が下地と見分けられない (画像の枠に市松が当たっていない)、または色を直書きしてテーマから浮く
//   2. サイズを出すためにタブの切替ごとに一覧を取り直す (ツリーの取得済みの行を使わない)
//   3. 寸法が別のタブの値になる (読み込み結果をパスと一緒に持たない)、読み込み前から寸法が出る
//   4. 画像以外のタブにメタが出る、または分からない値を「undefined × undefined」として出す
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("画像のメタはパス行に置き、画像のタブのときだけ出す", () => {
  const preview = read("src/components/FilePreview.tsx");
  // パス行 (パンくず / 表示の切替 / 行数) の中だけを見る。本文の描画側に足しても通らないようにする
  const pathRow = preview.slice(preview.indexOf("{fullscreen ? null : ("), preview.indexOf("{result?.error"));
  assert.match(pathRow, /<span className="[^"]*shrink-0 text-3xs[^"]*">\{imageMeta\}<\/span>/, "パス行にメタが無い");
  assert.match(preview, /const imageMeta = showImage\s*\?/, "画像以外のタブにもメタを出す条件になっている");
  // 分かる項目だけを並べる判定は lib/imageMeta.ts が正 (寸法もサイズも無ければ null)
  assert.match(preview, /imageMetaLabel\(activeSize,/, "渡されたサイズを使っていない");
});

test("画像の下地は市松で、色はテーマのトークンから作る", () => {
  const preview = read("src/components/FilePreview.tsx");
  assert.match(preview, /className="image-canvas\b/, "画像の枠に image-canvas を当てていない");
  const css = read("src/styles/index.css");
  const start = css.indexOf(".image-canvas {");
  assert.ok(start > css.indexOf("@layer components"), ".image-canvas が @layer components の外にある");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.match(rule, /repeating-conic-gradient\(/, "市松の反復が無い");
  assert.match(rule, /color-mix\(in srgb, var\(--c-ink\) \d+%, var\(--c-soft\)\)/, "色をトークンから作っていない");
  assert.match(rule, /background-size: 16px 16px;/, "1 タイルの大きさが無い (勾配が面全体へ広がる)");
  assert.ok(!rule.includes("#"), "色を直書きしている (6 テーマで追随しない)");
});

test("寸法は読み込み後に取り、表示中のタブの値だけを出す", () => {
  const preview = read("src/components/FilePreview.tsx");
  assert.match(preview, /onLoad=\{\(event\) =>/, "読み込み後に寸法を取っていない");
  assert.match(preview, /naturalWidth/, "内在の幅を読んでいない");
  assert.match(preview, /naturalHeight/, "内在の高さを読んでいない");
  assert.match(preview, /loadedImage\?\.path === activePath/, "タブを切り替えたら前のタブの寸法を出さない");
});

test("画像のサイズは取得済みのツリーの行から引く (メタ表示のために一覧を取り直さない)", () => {
  const browser = read("src/components/FileBrowser.tsx");
  assert.match(browser, /fileTreeEntryFor\(tree, tabs\.active\)\?\.size/, "ツリーの行からサイズを引いていない");
  assert.match(browser, /activeSize=\{activeSize\}/, "FilePreview へサイズを渡していない");
});
