// HTML プレビューの「新しいタブで開く」を成立させている実装を突き合わせる。どれかが崩れると、見えている本文と
// 違う文書が開く / 相対アセットの基準が iframe とずれる / 別タブで localStorage が使えない、のどれかになる。
// どれも型では防げない。
//   1. 出すのはプレビュー中だけ。置き場はパス行
//   2. 開く先は別オリジン (fileStoragePreviewUrl) の同じ html ルート。ポート未取得の間だけ同一オリジンへ倒す
//      (別タブを出す目的が localStorage を使えることなので、iframe の別オリジンのスイッチとは連動させない)
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
  const pathRow = preview.slice(
    preview.indexOf("flex items-center gap-3 px-4 py-1.5"),
    preview.indexOf("{result?.error"),
  );
  assert.match(pathRow, /<a\b[^>]*href=\{newTabSrc\}/, "パス行に新しいタブのリンクが無い");
  // showHtml は iframe と同じ条件 (プレビュー中 + HTML)。ソース表示から開くと描画結果が出て食い違う
  assert.match(pathRow, /\{showHtml \? \(/, "プレビュー中以外にも出している");
  assert.ok(pathRow.includes("<ExternalLinkIcon />"), "アイコンが無い");
});

test("iframe と同じ html ルートを別オリジンで開き、相対アセットの基準を共有する", () => {
  const preview = read("src/components/FilePreview.tsx");
  // 隔離モードは同一オリジン、ストレージ有効モードは別オリジン。どちらも同じ html ルート・同じ encode を使う
  assert.match(preview, /fileHtmlPreviewUrl\(fetchPath\)/, "隔離モードの iframe URL を使っていない");
  assert.match(
    preview,
    /fileStoragePreviewUrl\(fetchPath, filePreviewPort\)/,
    "有効モードの iframe URL を使っていない",
  );
  // 新しいタブは常に別オリジン (ストレージ有効側)。ポート未取得の間だけ同一オリジンへ倒す
  assert.match(
    preview,
    /const newTabSrc =\s*\n\s*filePreviewPort === undefined \? fileHtmlPreviewUrl\(fetchPath\) : fileStoragePreviewUrl\(fetchPath, filePreviewPort\)/,
    "新しいタブの URL を組み立て直している",
  );
  assert.match(preview, /href=\{newTabSrc\}/, "新しいタブの href が導出値でない");
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
