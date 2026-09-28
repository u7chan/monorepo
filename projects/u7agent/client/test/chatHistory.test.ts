// 全履歴ページのマージ / 前置き / 再構築の純関数テスト。実 DOM は使わず、バブル列と区切りの順序・状態だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import type { Bubble, CompactionMarker } from "../src/lib/chatTypes";
import type { HistoryBundle } from "../src/lib/chatHistory";
import {
  applyHistoryCounts,
  heldHistoryIds,
  historyItemsToBundle,
  mergeHistoryPage,
  prependHistoryPage,
  rebuildHistoryPage,
} from "../src/lib/chatHistory";
import type { CompactionInfo, HistoryItem, HistoryPage } from "../src/types";

function message(
  id: string,
  context: "active" | "summarized" | "excluded",
  text: string,
  role: "user" | "assistant" = "user",
): HistoryItem {
  return { kind: "message", id, context, role, text };
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
  overrides: Partial<
    Pick<
      HistoryPage,
      "prevCursor" | "nextCursor" | "hasMore" | "messageCount" | "summarizedMessageCount" | "activeContextStartId"
    >
  > = {},
): HistoryPage {
  const messages = items.filter((item) => item.kind === "message");
  return {
    sessionId: "session-a",
    items,
    prevCursor: overrides.prevCursor ?? null,
    nextCursor: overrides.nextCursor ?? null,
    hasMore: overrides.hasMore ?? false,
    activeContextStartId:
      overrides.activeContextStartId ?? messages.find((item) => item.context === "active")?.id ?? null,
    messageCount: overrides.messageCount ?? messages.length,
    summarizedMessageCount:
      overrides.summarizedMessageCount ?? messages.filter((item) => item.context === "summarized").length,
  };
}

const EMPTY: HistoryBundle = { bubbles: [], markers: [], nextId: 1, toolBubbleIds: {} };

function texts(bubbles: Bubble[]): string[] {
  return bubbles.map((bubble) => `${bubble.context ?? "live"}:${bubble.text}`);
}

function ids(bubbles: Bubble[]): string[] {
  return bubbles.map((bubble) => bubble.entryId ?? `live:${bubble.text}`);
}

function userItem(id: string, text: string): HistoryItem {
  return message(id, "active", text, "user");
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

test("heldHistoryIds は区切りを挟んだ item の並びを返す", () => {
  const bundle = historyItemsToBundle(1, [
    message("m1", "active", "a"),
    compactionItem("c1", "要約"),
    message("m2", "active", "b"),
  ]);
  assert.deepEqual(heldHistoryIds(bundle.bubbles, bundle.markers), ["m1", "c1", "m2"]);
});

test("resync は最新ページで新しい側だけを差し替え、取得済みの古いページを残す", () => {
  const older = mergeHistoryPage(
    EMPTY,
    page([userItem("m1", "古い質問"), userItem("m2", "古い答え")], {
      hasMore: true,
      nextCursor: "m1",
      messageCount: 4,
    }),
  );
  assert.equal(older.gap, false);
  const latest = page(
    [
      message("m3", "summarized", "要約された質問"),
      compactionItem("c1", "要約"),
      message("m4", "active", "最新の答え"),
    ],
    { prevCursor: "m2", hasMore: true, messageCount: 4, summarizedMessageCount: 1 },
  );

  const merged = mergeHistoryPage(older, latest);
  assert.equal(merged.gap, false);
  assert.deepEqual(texts(merged.bubbles), [
    "summarized:古い質問",
    "active:古い答え",
    "summarized:要約された質問",
    "active:最新の答え",
  ]);
  assert.equal(merged.bubbles.length, 4, "同じ entry を二度追加しない");
  assert.deepEqual(
    merged.markers.map((marker) => [marker.id, marker.index]),
    [["c1", 3]],
  );
  assert.equal(new Set(merged.bubbles.map((bubble) => bubble.id)).size, merged.bubbles.length, "bubble id は一意");
});

test("保持分と重ならない最新ページは欠落区間を取り直してから適用する (50件保持 + 60件追記)", () => {
  // 最初の 50 件を保持している
  const heldItems = Array.from({ length: 50 }, (_, index) => userItem(`h${index + 1}`, `h${index + 1}`));
  const held = mergeHistoryPage(EMPTY, page(heldItems, { hasMore: false, messageCount: 50 }));
  // 別タブで 60 件追記され、最新ページは p1..p50 (先頭の直前は g10 = 保持分に無い)
  const pending = page(
    Array.from({ length: 50 }, (_, index) => userItem(`p${index + 1}`, `p${index + 1}`)),
    { prevCursor: "g10", hasMore: true, nextCursor: "p1", messageCount: 110 },
  );
  const detected = mergeHistoryPage(held, pending);
  assert.equal(detected.gap, true, "繋がらないページは適用しない");
  assert.deepEqual(ids(detected.bubbles), ids(held.bubbles), "表示は保持分のまま");

  // 欠落区間のページ: 保持分の後半 + 欠落分 (h11..h50 + g1..g10)
  const gapPage = page(
    [
      ...Array.from({ length: 40 }, (_, index) => userItem(`h${index + 11}`, `h${index + 11}`)),
      ...Array.from({ length: 10 }, (_, index) => userItem(`g${index + 1}`, `g${index + 1}`)),
    ],
    { prevCursor: "h10", hasMore: true, nextCursor: "h11", messageCount: 110 },
  );
  const filled = mergeHistoryPage(held, gapPage);
  assert.equal(filled.gap, false);
  assert.deepEqual(ids(filled.bubbles), [
    ...Array.from({ length: 50 }, (_, index) => `h${index + 1}`),
    ...Array.from({ length: 10 }, (_, index) => `g${index + 1}`),
  ]);

  const applied = mergeHistoryPage(filled, pending);
  assert.equal(applied.gap, false);
  assert.deepEqual(ids(applied.bubbles), [
    ...Array.from({ length: 50 }, (_, index) => `h${index + 1}`),
    ...Array.from({ length: 10 }, (_, index) => `g${index + 1}`),
    ...Array.from({ length: 50 }, (_, index) => `p${index + 1}`),
  ]);
  assert.equal(applied.bubbles.length, 110, "欠落も重複も無い");
});

test("欠落区間が 1 ページに収まらない / 分岐が変わったときは最新ページで再構築する", () => {
  const held = mergeHistoryPage(EMPTY, page([userItem("h1", "h1"), userItem("h2", "h2")], { messageCount: 2 }));
  const pending = page([userItem("p1", "p1"), userItem("p2", "p2")], {
    prevCursor: "x9",
    hasMore: true,
    nextCursor: "p1",
    messageCount: 4,
  });
  assert.equal(mergeHistoryPage(held, pending).gap, true);
  // 欠落区間のページも繋がらない = 1 ページでは埋まらない
  const gapPage = page([userItem("y1", "y1")], { prevCursor: "x8", messageCount: 4 });
  assert.equal(mergeHistoryPage(held, gapPage).gap, true);
  const rebuilt = rebuildHistoryPage(held, pending);
  assert.equal(rebuilt.gap, false);
  assert.deepEqual(ids(rebuilt.bubbles), ["p1", "p2"]);
});

test("最新ページが空 (ブランチに item が無い) なら保持分を捨てる", () => {
  const held = mergeHistoryPage(EMPTY, page([userItem("old1", "old1")], { messageCount: 1 }));
  const merged = mergeHistoryPage(held, page([], { prevCursor: null, messageCount: 0 }));
  assert.equal(merged.gap, false);
  assert.deepEqual(merged.bubbles, []);
});

test("prevCursor が null のページ (ブランチ先頭) は保持分を捨てて組み直す", () => {
  const held = mergeHistoryPage(EMPTY, page([userItem("old1", "old1")], { messageCount: 3 }));
  const branch = page([userItem("x1", "x1"), userItem("x2", "x2")], {
    prevCursor: null,
    hasMore: true,
    nextCursor: "x1",
    messageCount: 3,
  });
  const merged = mergeHistoryPage(held, branch);
  assert.equal(merged.gap, false);
  assert.deepEqual(ids(merged.bubbles), ["x1", "x2"]);
});

test("保持分の途中を prevCursor が指すページは、そこまで残して置き換える", () => {
  const held = mergeHistoryPage(
    EMPTY,
    page([userItem("h1", "h1"), userItem("h2", "h2"), userItem("h3", "h3")], { messageCount: 5 }),
  );
  const merged = mergeHistoryPage(
    held,
    page([userItem("h3", "h3"), userItem("h4", "h4")], {
      prevCursor: "h2",
      hasMore: true,
      nextCursor: "h3",
      messageCount: 5,
    }),
  );
  assert.equal(merged.gap, false);
  assert.deepEqual(ids(merged.bubbles), ["h1", "h2", "h3", "h4"]);
});

test("同じ文面の過去発言があっても、新しい領域の entry とだけ突き合わせてエコーを残す", () => {
  const heldItems = [
    userItem("h1", "同じ質問"),
    ...Array.from({ length: 10 }, (_, index) => userItem(`h${index + 2}`, `x${index}`)),
  ];
  const held = mergeHistoryPage(EMPTY, page(heldItems, { hasMore: true, nextCursor: "h1", messageCount: 11 }));
  const echo: Bubble = { id: 99, role: "user", text: "同じ質問", tools: [], skillLoads: [] };
  // 最新ページは保持分と重なる (h2..h11) が、送信分の entry はまだ無い
  const overlapping = page(
    Array.from({ length: 10 }, (_, index) => userItem(`h${index + 2}`, `x${index}`)),
    { prevCursor: "h1", hasMore: true, nextCursor: "h2", messageCount: 11 },
  );
  const keptEcho = mergeHistoryPage(held, overlapping, { live: [echo], pendingEchoIds: [99] });
  assert.equal(keptEcho.gap, false);
  assert.deepEqual(keptEcho.pendingEchoIds, [99], "過去の同一文面では消費しない");
  assert.equal(keptEcho.bubbles.filter((bubble) => bubble.id === 99).length, 1);

  // 送信分の entry が現れたら、新しい領域の item と一致してエコーを消費する
  const withEntry = page(
    [...Array.from({ length: 10 }, (_, index) => userItem(`h${index + 2}`, `x${index}`)), userItem("n1", "同じ質問")],
    { prevCursor: "h1", hasMore: true, nextCursor: "h2", messageCount: 12 },
  );
  const consumed = mergeHistoryPage(held, withEntry, { live: [echo], pendingEchoIds: [99] });
  assert.deepEqual(consumed.pendingEchoIds, [], "entry が現れたエコーは消費する");
  assert.equal(
    consumed.bubbles.some((bubble) => bubble.id === 99),
    false,
  );
  assert.equal(consumed.bubbles.filter((bubble) => bubble.entryId === "n1").length, 1, "二重表示しない");
});

test("確定済みライブバブルはページの手前へ戻し、送信直後のエコーは末尾に残す", () => {
  const held = mergeHistoryPage(
    EMPTY,
    page([userItem("m1", "m1")], { hasMore: true, nextCursor: "m1", messageCount: 3 }),
  );
  const settled: Bubble = { id: 2, settled: true, role: "assistant", text: "古い応答", tools: [], skillLoads: [] };
  const echo: Bubble = { id: 3, role: "user", text: "新しい質問", tools: [], skillLoads: [] };
  const merged = mergeHistoryPage(
    held,
    page([userItem("m2", "m2")], { prevCursor: "m1", hasMore: true, nextCursor: "m2", messageCount: 3 }),
    { live: [settled, echo], pendingEchoIds: [3] },
  );
  assert.deepEqual(texts(merged.bubbles), ["active:m1", "live:古い応答", "active:m2", "live:新しい質問"]);
  assert.deepEqual(merged.pendingEchoIds, [3]);
});

test("確定済みライブバブルを戻した分だけ区切りの位置もずれる", () => {
  const held = mergeHistoryPage(
    EMPTY,
    page([userItem("m0", "m0")], { hasMore: true, nextCursor: "m0", messageCount: 3 }),
  );
  const settled: Bubble = { id: 3, settled: true, role: "user", text: "古いターン", tools: [], skillLoads: [] };
  const merged = mergeHistoryPage(
    held,
    page([userItem("m1", "a"), compactionItem("c1", "要約"), userItem("m2", "b")], {
      prevCursor: "m0",
      hasMore: true,
      nextCursor: "m1",
      messageCount: 3,
    }),
    { live: [settled] },
  );
  assert.deepEqual(texts(merged.bubbles), ["active:m0", "live:古いターン", "active:a", "active:b"]);
  assert.deepEqual(
    merged.markers.map((marker) => [marker.id, marker.index]),
    [["c1", 3]],
  );
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
    prepended.markers.map((marker: CompactionMarker) => [marker.id, marker.index]),
    [
      ["c1", 1],
      ["c2", 3],
    ],
  );
});
