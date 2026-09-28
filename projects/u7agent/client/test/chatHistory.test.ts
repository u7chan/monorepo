// 全履歴ページのマージ / 前置きの純関数テスト。実 DOM は使わず、バブル列と区切りの順序・状態だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import type { Bubble, CompactionMarker } from "../src/lib/chatTypes";
import { applyHistoryCounts, historyItemsToBundle, mergeHistoryPage, prependHistoryPage } from "../src/lib/chatHistory";
import type { CompactionInfo, HistoryItem, HistoryPage } from "../src/types";

function message(id: string, context: "active" | "summarized" | "excluded", text: string): HistoryItem {
  return { kind: "message", id, context, role: "user", text };
}

function compactionItem(id: string, summary: string): HistoryItem {
  const compaction: CompactionInfo = {
    id,
    parentId: null,
    timestamp: "",
    summary,
    firstKeptEntryId: "",
    tokensBefore: 1,
  };
  return { kind: "compaction", id, compaction };
}

function page(
  items: HistoryItem[],
  overrides: {
    nextCursor?: string | null;
    hasMore?: boolean;
    messageCount?: number;
    summarizedMessageCount?: number;
    activeContextStartId?: string | null;
  } = {},
): HistoryPage {
  const messages = items.filter((item) => item.kind === "message");
  return {
    sessionId: "session-a",
    items,
    nextCursor: overrides.nextCursor ?? null,
    hasMore: overrides.hasMore ?? false,
    activeContextStartId:
      overrides.activeContextStartId ?? messages.find((item) => item.context === "active")?.id ?? null,
    messageCount: overrides.messageCount ?? messages.length,
    summarizedMessageCount:
      overrides.summarizedMessageCount ?? messages.filter((item) => item.context === "summarized").length,
  };
}

function texts(bubbles: Bubble[]): string[] {
  return bubbles.map((bubble) => `${bubble.context ?? "live"}:${bubble.text}`);
}

test("historyItemsToBundle は item を entry id 付きのバブルと区切り位置へ写す", () => {
  const bundle = historyItemsToBundle(1, [
    message("m1", "summarized", "古い質問"),
    compactionItem("c1", "1回目の要約"),
    message("m2", "active", "新しい質問"),
  ]);
  assert.deepEqual(
    bundle.bubbles.map((bubble) => [bubble.entryId, bubble.context, bubble.text]),
    [
      ["m1", "summarized", "古い質問"],
      ["m2", "active", "新しい質問"],
    ],
  );
  assert.deepEqual(
    bundle.markers.map((marker) => [marker.id, marker.index]),
    [["c1", 1]],
  );
  assert.equal(bundle.markers[0].compactions[0].summary, "1回目の要約");
  assert.equal(bundle.bubbles[0].id, 1);
  assert.equal(bundle.bubbles[1].id, 2);
  assert.equal(bundle.nextId, 3);
});

test("resync は最新ページで新しい側だけを差し替え、取得済みの古いページを残す", () => {
  const older = historyItemsToBundle(1, [message("m1", "active", "古い質問"), message("m2", "active", "古い答え")]);
  const first = prependHistoryPage(
    { ...older, messageCount: 4, summarizedMessageCount: 0 },
    page([message("m1", "active", "古い質問"), message("m2", "active", "古い答え")], {
      hasMore: true,
      messageCount: 4,
    }),
  );
  const latest = page(
    [
      message("m3", "summarized", "要約された質問"),
      compactionItem("c1", "要約"),
      message("m4", "active", "最新の答え"),
    ],
    {
      hasMore: true,
      messageCount: 4,
      summarizedMessageCount: 1,
    },
  );

  const merged = mergeHistoryPage(
    { bubbles: first.bubbles, markers: first.markers, nextId: first.nextId, toolBubbleIds: first.toolBubbleIds },
    latest,
  );
  assert.deepEqual(texts(merged.bubbles), [
    "summarized:古い質問",
    "active:古い答え",
    "summarized:要約された質問",
    "active:最新の答え",
  ]);
  assert.equal(merged.bubbles.length, 4, "同じ entry を二度追加しない");
  assert.deepEqual(
    merged.markers.map((marker: CompactionMarker) => [marker.id, marker.index]),
    [["c1", 3]],
  );
  assert.equal(new Set(merged.bubbles.map((bubble) => bubble.id)).size, merged.bubbles.length, "bubble id は一意");
});

test("compaction で境界が動いても、保持済みの古いページを summarized へ更新する", () => {
  // 圧縮前: 全件 active のまま最新ページだけ取得していた
  const before = historyItemsToBundle(1, [message("m1", "active", "a"), message("m2", "active", "b")]);
  const pageAfter = page([message("m3", "active", "c")], {
    hasMore: true,
    messageCount: 3,
    summarizedMessageCount: 2,
    activeContextStartId: "m3",
  });
  const merged = mergeHistoryPage({ ...before, toolBubbleIds: {} }, pageAfter);
  assert.deepEqual(texts(merged.bubbles), ["summarized:a", "summarized:b", "active:c"]);
});

test("applyHistoryCounts は未取得の summarized が先頭にあっても位置をずらさない", () => {
  // 全体 5 件のうち summarized 3 件。クライアントは新しい 2 件だけ保持している
  const bubbles: Bubble[] = historyItemsToBundle(1, [
    message("m4", "active", "d"),
    message("m5", "active", "e"),
  ]).bubbles;
  const updated = applyHistoryCounts(bubbles, 5, 3);
  assert.deepEqual(texts(updated), ["active:d", "active:e"]);
  // さらに古いページ (m1..m3) を足すと、先頭 3 件が summarized になる
  const prepended = prependHistoryPage(
    { bubbles: updated, markers: [], nextId: 3, toolBubbleIds: {}, messageCount: 5, summarizedMessageCount: 3 },
    page(
      [
        message("m1", "summarized", "a"),
        message("m2", "summarized", "b"),
        message("m3", "summarized", "c"),
        message("m4", "active", "d"),
        message("m5", "active", "e"),
      ],
      {
        messageCount: 5,
        summarizedMessageCount: 3,
      },
    ),
  );
  assert.deepEqual(texts(prepended.bubbles), ["summarized:a", "summarized:b", "summarized:c", "active:d", "active:e"]);
});

test("古いページの前置きは重複を捨て、区切りの位置をずらす", () => {
  const current = historyItemsToBundle(10, [message("m3", "active", "c"), compactionItem("c2", "2回目")]);
  const prepended = prependHistoryPage(
    {
      bubbles: current.bubbles,
      markers: current.markers,
      nextId: current.nextId,
      toolBubbleIds: {},
      messageCount: 3,
      summarizedMessageCount: 0,
    },
    page(
      [
        message("m1", "summarized", "a"),
        compactionItem("c1", "1回目"),
        message("m2", "summarized", "b"),
        message("m3", "active", "c"),
      ],
      {
        messageCount: 3,
        summarizedMessageCount: 2,
        activeContextStartId: "m3",
      },
    ),
  );
  assert.equal(prepended.prepended, 2);
  assert.deepEqual(
    prepended.bubbles.map((bubble) => [bubble.entryId, bubble.context]),
    [
      ["m1", "summarized"],
      ["m2", "summarized"],
      ["m3", "active"],
    ],
  );
  assert.deepEqual(
    prepended.markers.map((marker) => [marker.id, marker.index]),
    [
      ["c1", 1],
      ["c2", 3],
    ],
  );
});

test("確定済みのライブバブルはページの手前へ戻し、送信直後のエコーは末尾に残す", () => {
  const prev: {
    bubbles: Bubble[];
    markers: CompactionMarker[];
    nextId: number;
    toolBubbleIds: Record<string, number>;
  } = {
    bubbles: [
      { id: 1, role: "user", text: "こんにちは", tools: [], skillLoads: [] },
      { id: 2, entryId: "m1", context: "active", role: "assistant", text: "はい", tools: [], skillLoads: [] },
      { id: 3, settled: true, role: "user", text: "古いターン", tools: [], skillLoads: [] },
      { id: 4, settled: true, role: "assistant", text: "古い応答", tools: [], skillLoads: [] },
    ],
    markers: [],
    nextId: 5,
    toolBubbleIds: {},
  };
  const live = [prev.bubbles[0], prev.bubbles[2], prev.bubbles[3]];
  const merged = mergeHistoryPage(prev, page([message("m1", "active", "こんにちは")]), {
    live,
    pendingEchoIds: [1],
  });
  assert.deepEqual(texts(merged.bubbles), ["live:古いターン", "live:古い応答", "active:こんにちは"]);

  // ページに同じ発言が無い間はエコーを末尾へ残す
  const waiting = mergeHistoryPage(prev, page([message("m2", "active", "別の発言")]), {
    live: [prev.bubbles[0]],
    pendingEchoIds: [1],
  });
  assert.deepEqual(texts(waiting.bubbles), ["active:別の発言", "live:こんにちは"]);
});

test("確定済みライブバブルを戻した分だけ区切りの位置もずれる", () => {
  const prev = {
    bubbles: [{ id: 3, settled: true, role: "user", text: "古いターン", tools: [], skillLoads: [] }] as Bubble[],
    markers: [] as CompactionMarker[],
    nextId: 4,
    toolBubbleIds: {},
  };
  const merged = mergeHistoryPage(
    prev,
    page([message("m1", "active", "a"), compactionItem("c1", "要約"), message("m2", "active", "b")]),
    { live: [prev.bubbles[0]] },
  );
  assert.deepEqual(texts(merged.bubbles), ["live:古いターン", "active:a", "active:b"]);
  assert.deepEqual(
    merged.markers.map((marker) => [marker.id, marker.index]),
    [["c1", 2]],
  );
});
