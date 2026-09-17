// compact の詳細シートで「Escape 1 回 = シートだけを閉じる」を成立させている 3 つの実装を突き合わせる。
// どれか 1 つが崩れると Escape がチャットまで抜ける (か、何も起きなくなる) が、型では防げない。
//   1. シートは モーダル dialog として開く (Escape で閉じるのは showModal の標準挙動)
//   2. シートは Escape の keydown を window へ伝播させない (伝播すると App が同時にチャットへ戻す)
//   3. App は window の keydown を bubble で受ける (2 が効く位置。capture にすると 2 を追い越す)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("詳細シートはモーダル dialog で開き、Escape を window へ伝播させない", () => {
  const sheet = read("src/components/SettingsDetailSheet.tsx");
  assert.match(
    sheet,
    /dialog\.showModal\(\)/,
    "showModal() で開く (Escape での終了とフォーカス拘束は標準挙動に任せる)",
  );
  assert.match(sheet, /event\.key === "Escape"\) event\.stopPropagation\(\)/, "Escape の keydown を止める");
});

test("App は設定ページの Escape を window の bubble で受ける (シートが先に止められる位置)", () => {
  const app = read("src/App.tsx");
  assert.match(app, /window\.addEventListener\("keydown", onKeyDown\)/, "capture を付けない");
});
