// 手動圧縮の可否は総量ではなくメッセージ境界で決まる。SDK 公開の純関数 (findCutPoint / estimateTokens) を
// 直接叩き、docs/compaction.md の表 (どの形で切れるか) を固定する。実 API は呼ばない。
import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, findCutPoint } from "@earendil-works/pi-coding-agent";

type CutEntries = Parameters<typeof findCutPoint>[0];
type CutEntry = CutEntries[number];
type EstimateMessage = Parameters<typeof estimateTokens>[0];

/** 推定 tokens が `tokens` になる本文 (estimateTokens は文字数 ÷ 4 の切り上げ) */
const body = (tokens: number): string => "x".repeat(tokens * 4);

let seq = 0;

function messageOf(role: "user" | "assistant", tokens: number): EstimateMessage {
  const text = tokens === 1 ? "x" : body(tokens);
  // findCutPoint / estimateTokens が見るのは role と content だけ
  return { role, content: [{ type: "text", text }], timestamp: 0 } as unknown as EstimateMessage;
}

function messageEntry(role: "user" | "assistant", tokens: number): CutEntry {
  seq += 1;
  return {
    type: "message",
    id: `e${seq}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: messageOf(role, tokens),
  } as unknown as CutEntry;
}

/**
 * prepareCompaction の可否判定 (messagesToSummarize か turnPrefixMessages が 1 件以上) を、
 * 直前の compaction が無い場合に限り公開関数から再現する。message entry は 1 件 = 1 メッセージ。
 */
function prepare(entries: CutEntry[], keepRecentTokens = 20_000) {
  const cut = findCutPoint(entries, 0, entries.length, keepRecentTokens);
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  return {
    // 先頭から cut 地点までが履歴要約、split-turn の前半が prefix 要約 (別リクエスト)
    history: historyEnd,
    prefix: cut.isSplitTurn ? cut.firstKeptEntryIndex - cut.turnStartIndex : 0,
    compactible: historyEnd > 0 || (cut.isSplitTurn && cut.firstKeptEntryIndex > cut.turnStartIndex),
  };
}

test("推定 tokens は文字数 ÷ 4 を切り上げた値になる", () => {
  assert.equal(estimateTokens(messageOf("user", 1)), 1);
  assert.equal(estimateTokens(messageOf("assistant", 10_000)), 10_000);
});

test("推定 20,000 ちょうどは境界が先頭に載り、要約対象が 0 件になる", () => {
  const entries = [
    messageEntry("user", 5_000),
    messageEntry("assistant", 5_000),
    messageEntry("user", 5_000),
    messageEntry("assistant", 5_000),
  ];
  assert.deepEqual(prepare(entries), { history: 0, prefix: 0, compactible: false });
});

test("20,001 は role の並びで履歴 1 件または prefix 1 件だけになり、どちらも実行できる", () => {
  // assistant で切れて split-turn になるときは、先頭の user 1 件だけが prefix 要約になる
  const split = prepare([messageEntry("user", 1), messageEntry("assistant", 10_000), messageEntry("user", 10_000)]);
  assert.deepEqual(split, { history: 0, prefix: 1, compactible: true });

  // user で切れるときはその手前の履歴要約 1 件だけになる
  const plain = prepare([messageEntry("user", 1), messageEntry("user", 10_000), messageEntry("user", 10_000)]);
  assert.deepEqual(plain, { history: 1, prefix: 0, compactible: true });
});

test("均等に並んだ 25,000 は総量が足りていても要約できない", () => {
  const entries = [
    messageEntry("user", 6_250),
    messageEntry("assistant", 6_250),
    messageEntry("user", 6_250),
    messageEntry("assistant", 6_250),
  ];
  assert.deepEqual(prepare(entries), { history: 0, prefix: 0, compactible: false });
});

test("単一の長い user メッセージは 30,000 でも要約できない", () => {
  assert.deepEqual(prepare([messageEntry("user", 30_000)]), { history: 0, prefix: 0, compactible: false });
});

test("40,000 から要約が始まり、80,000 では split-turn の prefix も付く", () => {
  const even = [
    messageEntry("user", 10_000),
    messageEntry("assistant", 10_000),
    messageEntry("user", 10_000),
    messageEntry("assistant", 10_000),
  ];
  assert.deepEqual(prepare(even), { history: 2, prefix: 0, compactible: true });

  const large = [
    messageEntry("user", 20_000),
    messageEntry("assistant", 20_000),
    messageEntry("user", 20_000),
    messageEntry("assistant", 20_000),
  ];
  // 履歴要約 1 リクエスト + prefix 要約 1 リクエストの 2 回になる
  assert.deepEqual(prepare(large), { history: 2, prefix: 1, compactible: true });
});
