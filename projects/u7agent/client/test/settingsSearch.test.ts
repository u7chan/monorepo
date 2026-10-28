// 設定の一覧の絞り込み。検索は**表示だけ**を絞り、個別切替と一括操作の母集合は未絞込の visible 行に
// 残す。ここが崩れると、検索中に 1 件外しただけで隠れていた ON の行まで OFF になる。
import assert from "node:assert/strict";
import test from "node:test";
import { toggleAllowed } from "../src/lib/agentAllowlist";
import { filterBySearch, matchesQuery, normalizeQuery } from "../src/lib/settingsSearch";

const ROWS = [
  { name: "alpha", description: "アルファの説明" },
  { name: "beta", description: "ベータの説明" },
  { name: "gamma", description: "ガンマの説明" },
];
const fields = (row: { name: string; description: string }) => [row.name, row.description];

test("検索語は前後の空白を落として大文字小文字を区別しない", () => {
  assert.equal(normalizeQuery("  Alpha "), "alpha");
  assert.equal(matchesQuery("", ["alpha"]), true, "空の検索語は常に一致する");
  assert.equal(matchesQuery("  ", ["alpha"]), true);
  assert.equal(matchesQuery("ALP", ["alpha", "説明"]), true);
  assert.equal(matchesQuery("アルファ", ["alpha", "アルファの説明"]), true);
  assert.equal(matchesQuery("zzz", ["alpha", "説明"]), false);
  assert.equal(matchesQuery("alpha", [undefined]), false, "欠けた項目は空文字として扱う");
});

test("絞り込みは元の順を保ち、一致が無ければ空になる", () => {
  assert.deepEqual(
    filterBySearch(ROWS, "", fields).map((row) => row.name),
    ["alpha", "beta", "gamma"],
  );
  assert.deepEqual(
    filterBySearch(ROWS, "a", fields).map((row) => row.name),
    ["alpha", "beta", "gamma"],
    "説明にも a を含むため全部残る",
  );
  assert.deepEqual(
    filterBySearch(ROWS, "bet", fields).map((row) => row.name),
    ["beta"],
  );
  assert.deepEqual(filterBySearch(ROWS, "zzz", fields), []);
});

test("検索中に 1 件外しても、母集合は未絞込の visible 行のまま (隠れた ON が残る)", () => {
  const visible = ROWS.map((row) => row.name);
  const shown = filterBySearch(ROWS, "alp", fields).map((row) => row.name);
  assert.deepEqual(shown, ["alpha"], "表示は 1 件に絞られる");
  // 画面は切替に visible 全件を渡す。検索結果だけを渡すと beta / gamma まで OFF になる
  const next = toggleAllowed(undefined, shown[0], false, visible);
  assert.deepEqual(next, ["beta", "gamma"]);
  // 検索を解除しても、隠れていた行は ON のまま
  const restored = toggleAllowed(next, "alpha", true, visible);
  assert.deepEqual(restored, ["beta", "gamma", "alpha"]);
});
