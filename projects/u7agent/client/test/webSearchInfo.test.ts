// web_search の結果本文から provider 名を読む純関数の検証。結果本文の形の正は
// server/src/web-search-tool.ts（すべての結果に日時行と provider 行を前置する）。
import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCard } from "../src/lib/chatTypes";
import { webSearchProviderOf } from "../src/lib/webSearchInfo";

const HEADER = "現在日時: 2026-10-07 (Asia/Tokyo)\n検索プロバイダー: Exa\n";

function card(overrides: Partial<ToolCard> = {}): ToolCard {
  return { id: "call-1", name: "web_search", args: "{}", phase: "done", output: `${HEADER}出典:`, ...overrides };
}

test("成功本文の provider 行を読む", () => {
  assert.equal(webSearchProviderOf(card()), "Exa");
  assert.equal(webSearchProviderOf(card({ output: `${HEADER}出典:\n[1] T — https://example.com` })), "Exa");
});

test("失敗カードの本文でも provider 行を読む", () => {
  const output = "現在日時: 2026-10-07 (Asia/Tokyo)\n検索プロバイダー: Tavily\n検索が混雑しています（レート制限）";
  assert.equal(webSearchProviderOf(card({ phase: "failed", output })), "Tavily");
});

test("provider 行が無い・値が空白だけの本文では返さない", () => {
  assert.equal(webSearchProviderOf(card({ output: "現在日時: 2026-10-07 (Asia/Tokyo)\n出典:" })), undefined);
  assert.equal(webSearchProviderOf(card({ output: "" })), undefined);
  assert.equal(webSearchProviderOf(card({ output: "検索プロバイダー:   \n出典:" })), undefined);
});

test("改行で終わらない provider 行は値として読まない", () => {
  // 投影（先頭 900 文字）で切られた断片は値を欠いている可能性があり、確定値と区別できない
  assert.equal(
    webSearchProviderOf(card({ output: "現在日時: 2026-10-07 (Asia/Tokyo)\n検索プロバイダー: Exa" })),
    undefined,
  );
  assert.equal(
    webSearchProviderOf(card({ output: "現在日時: 2026-10-07 (Asia/Tokyo)\n検索プロバイダー: Exa\n" })),
    "Exa",
  );
});

test("対象外のツールでは本文に同じ行があっても読まない", () => {
  assert.equal(webSearchProviderOf(card({ name: "bash" })), undefined);
  assert.equal(webSearchProviderOf(card({ name: "generate_image" })), undefined);
});

test("先頭 3 行より後ろの provider 行は読まない", () => {
  const output = `現在日時: 2026-10-07 (Asia/Tokyo)\n出典:\n[1] T — https://example.com\n\n${HEADER}`;
  assert.equal(webSearchProviderOf(card({ output })), undefined);
});
