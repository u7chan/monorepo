// ファイルプレビューの「本文をコピー」を成立させている実装を突き合わせる。どれかが崩れると、行番号が
// 混ざる / 画像と HTML のプレビューに出る / タブを切り替えても成功表示が残る、のどれかになる。どれも型では防げない。
//   1. ボタンはソース表示のパス行 (行数の隣) に置き、渡す props を式ごと固定する (行番号を前へ足せない)
//   2. FileCopyButton の中でも reveal を渡さず (hover できる端末でも隠さない)、渡された本文をそのままコピーする
//   3. 本文を取得しない画像 / HTML のプレビューでは code が null になり、ボタンも同じ条件で消える
//   4. key を表示中のタブに張り替えて、タブを切り替えたら成功表示を捨てる (見えている本文が変わるため)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("本文のコピーボタンはソース表示のパス行に置き、表示中の本文だけを渡す", () => {
  const preview = read("src/components/FilePreview.tsx");
  // パス行 (パス / 表示の切替 / 行数) の中だけを見る。本文の描画側や全画面側に置いても通らないようにする
  const pathRow = preview.slice(preview.indexOf("{fullscreen ? null : ("), preview.indexOf("{result?.error"));
  assert.ok(pathRow.includes("<FileCopyButton"), "パス行にコピーボタンが無い");
  // 呼び出し側で文字列を組み立てられないよう、渡す props を式ごと固定する (行番号を前へ足す変更も落ちる)
  assert.match(pathRow, /<FileCopyButton[^>]*\btext=\{previewCopyText\(code\)\}/, "表示中の本文だけを渡していない");
  assert.match(pathRow, /<FileCopyButton[^>]*\bkey=\{activePath\}/, "key を張り替えてタブごとに状態を捨てる");
});

test("コピーボタンは hover でも隠さず、渡された本文をそのままコピーする", () => {
  const preview = read("src/components/FilePreview.tsx");
  // FileCopyButton の中も見る (呼び出し側だけを見ると、中の CopyButton に reveal を足す変更を検出できない)
  const start = preview.indexOf("function FileCopyButton");
  assert.ok(start >= 0, "FileCopyButton が無い");
  const button = preview.slice(start, preview.indexOf("function PreviewModeToggle"));
  assert.ok(!button.includes("reveal="), "reveal を渡すと hover できる端末で隠れる");
  // text をそのまま渡す (copyMessage(text + …) のような組み立てはこの形に一致しない)
  assert.match(button, /copyMessage\(text,/, "渡された本文をそのままコピーしていない");
  assert.ok(preview.includes('label="本文をコピー"'), "押した結果が分かるラベルが無い");
});

test("画像 / HTML のプレビューでは本文を取得しないので、コピーボタンも出さない", () => {
  const preview = read("src/components/FilePreview.tsx");
  // 画像 / HTML のプレビューは skipFetch になり、描画モデルを作らない (lang · N 行 も出ない)
  assert.match(preview, /skipFetch \|\| text === undefined \? null : buildPreviewCode/, "本文を取得しない");
  // 本文が無いタブ (読み込み中 / 失敗) と画像 / HTML のプレビューは、同じ条件でボタンも消す
  assert.match(preview, /\{code === null \? null : <FileCopyButton/, "code が無いのにボタンを出す");
});
