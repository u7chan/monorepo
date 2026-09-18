// HTML プレビューの全画面を成立させている実装を突き合わせる。どれかが崩れると、iframe が再読み込みされる
// (dialog を作り直す / 2 つ目の iframe を持つ) か、Escape 1 回でチャットまで戻るか、他タブへ移ってもモーダルが残る。
// どれも型では防げない。
//   1. 全画面は dialog.showModal() で開く (top layer に出す。dialog は全画面でなくても常に置く)
//   2. Escape の keydown は全画面のときだけ止める (止めないと App が同じ Escape でチャットへ戻す)
//   3. <iframe> は 1 つだけ (全画面用の 2 つ目を作らない = 出入りで作り直さない)
//   4. 全画面を出すときのタブを覚える (表示対象が変わったら解除する。条件は lib/fileTabs.ts が正)
//   5. 全画面の dialog に残すのは 戻るボタンだけで、タブバーとパス行の中身は出さない
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

test("全画面は出すときのタブを覚え、表示対象が変わったら解除する", () => {
  const preview = read("src/components/FilePreview.tsx");
  // 表示中のタブだけで条件を引くと、HTML 同士のタブ切替や繰り上がりでモーダルが残る
  assert.match(
    preview,
    /const fullscreen = keepsFullscreenPreview\(fullscreenPath, activePath, mode\)/,
    "出すときのタブと表示中のタブの両方で条件を引く",
  );
  assert.match(preview, /setFullscreenPath\(fullscreen \? null : activePath\)/, "全画面を表示中のタブに紐づける");
});

test("全画面は タブバーとパス行の中身を出さず、戻るボタンだけを残す", () => {
  const preview = read("src/components/FilePreview.tsx");
  // タブの選択は全画面の解除でもあるため、全画面でタブを出すと「押すと解除される」行になる。
  // 見た目を消すだけ (unmount しない) のは、横スクロールの位置をタブ側に保たせるため
  assert.match(preview, /fullscreen && "hidden"/, "タブバーは全画面で隠す");
  // パス / 表示の切替 / 行数は全画面では描かない (戻る以外の操作を並べない)
  assert.match(preview, /\{fullscreen \? null : \(/, "パス行の中身は全画面で描画しない");
  // 重ねるボタンを作らず 1 つに保つ (2 つ目は Escape の扱いとフォーカスを二重にする)
  assert.equal(preview.match(/全画面をやめる/g)?.length, 1, "戻るボタンは 1 つだけ");
});
