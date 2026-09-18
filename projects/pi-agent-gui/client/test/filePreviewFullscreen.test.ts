// HTML プレビューの全画面を成立させている実装を突き合わせる。どれかが崩れると、iframe が再読み込みされる
// (dialog を作り直す / 2 つ目の iframe を持つ) か、Escape 1 回でチャットまで戻る。どちらも型では防げない。
//   1. 全画面は dialog.showModal() で開く (top layer に出す。dialog は全画面でなくても常に置く)
//   2. Escape の keydown は全画面のときだけ止める (止めないと App が同じ Escape でチャットへ戻す)
//   3. <iframe> は 1 つだけ (全画面用の 2 つ目を作らない = 出入りで作り直さない)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("プレビューの全画面はモーダル dialog で開き、Escape は全画面のときだけ止める", () => {
  const preview = read("src/components/FilePreview.tsx");
  assert.match(preview, /dialog\.showModal\(\)/, "showModal() で開く (終了とフォーカス拘束は標準挙動に任せる)");
  assert.match(
    preview,
    /event\.key === "Escape" && fullscreen\) event\.stopPropagation\(\)/,
    "Escape の keydown を全画面のときだけ止める",
  );
});

test("プレビューの iframe は 1 つだけ (全画面の出入りで作り直さない)", () => {
  const preview = read("src/components/FilePreview.tsx");
  assert.equal(preview.match(/<iframe/g)?.length, 1, "全画面用の 2 つ目の iframe を作らない");
});
