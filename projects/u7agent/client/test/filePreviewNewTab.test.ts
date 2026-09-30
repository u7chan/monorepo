// HTML プレビューの「新しいタブで開く」を成立させている実装を突き合わせる。どれかが崩れると、見えている本文と
// 違う文書が開く / 相対アセットの基準が iframe とずれる / 新しいタブからアプリ側へ触れる、のどれかになる。
// どれも型では防げない。
//   1. 出すのはプレビュー中だけ。置き場はパス行で、全画面 (戻るボタンだけを残す) では描かないブロックの中
//   2. 開く先は iframe と同じ fileHtmlPreviewUrl(fetchPath) (セグメント単位の encode と相対アセットの基準を共有する)
//   3. target="_blank" と rel="noreferrer noopener" を持つ (window.open は使わない)
//   4. アイコンだけのリンクなので aria-label / title で名前を持たせる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("新しいタブのリンクはパス行に置き、HTML プレビューのときだけ出す", () => {
  const preview = read("src/components/FilePreview.tsx");
  // パス行 (パンくず / 表示の切替 / メタ) の中だけを見る。本文の描画側に足しても通らないようにする
  const pathRow = preview.slice(preview.indexOf("{fullscreen ? null : ("), preview.indexOf("{result?.error"));
  assert.match(pathRow, /<a\b[^>]*href=\{fileHtmlPreviewUrl\(fetchPath\)\}/, "パス行に新しいタブのリンクが無い");
  // showHtml は iframe と同じ条件 (プレビュー中 + HTML)。ソース表示から開くと描画結果が出て食い違う
  assert.match(pathRow, /\{showHtml \? \(/, "プレビュー中以外にも出している");
  // 全画面では戻るボタンだけを残すため、パス行の中身を描かないブロックに置く
  assert.ok(pathRow.includes("<ExternalLinkIcon />"), "アイコンが無い");
});

test("iframe と同じ html ルートを開き、相対アセットの基準を共有する", () => {
  const preview = read("src/components/FilePreview.tsx");
  assert.match(preview, /src=\{fileHtmlPreviewUrl\(fetchPath\)\}/, "iframe と同じ URL を使っていない");
  // path を組み立て直すと encode と (文書と同じディレクトリを基準にする) 相対参照の前提がずれる
  assert.match(preview, /href=\{fileHtmlPreviewUrl\(fetchPath\)\}/, "URL を組み立て直している");
});

test("新しいタブとして開き、遷移元 (アプリのタブ) へ触れさせない", () => {
  const preview = read("src/components/FilePreview.tsx");
  assert.match(preview, /target="_blank"/, "新しいタブで開かない");
  assert.match(preview, /rel="noreferrer noopener"/, "noopener が無い");
  // window.open を使うとポップアップブロッカーと中クリック / URL のコピーを自前で扱うことになる
  assert.ok(!preview.includes("window.open"), "window.open を使っている");
});

test("アイコンだけのリンクに名前を付ける", () => {
  const preview = read("src/components/FilePreview.tsx");
  assert.match(preview, /aria-label="新しいタブで開く"/, "読み上げの名前が無い");
  assert.match(preview, /title="新しいタブで開く"/, "ポインタの説明が無い");
});
