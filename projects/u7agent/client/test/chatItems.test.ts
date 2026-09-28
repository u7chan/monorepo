// 全履歴の描画順・境界・仮想スクロールの見積り・前置き時のスクロール補正の純関数テスト。
import assert from "node:assert/strict";
import test from "node:test";
import type { Bubble, CompactionMarker } from "../src/lib/chatTypes";
import { anchoredScrollTop, chatRenderItems, estimateChatItemHeight } from "../src/lib/chatItems";
import type { CompactionInfo } from "../src/types";

function bubble(id: number, entryId: string, context: Bubble["context"], text: string): Bubble {
  return { id, entryId, context, role: "assistant", text, tools: [], skillLoads: [] };
}

const COMPACTIONS: CompactionInfo[] = [
  { id: "c1", parentId: null, timestamp: "", summary: "1", firstKeptEntryId: "", tokensBefore: 1 },
  { id: "c2", parentId: null, timestamp: "", summary: "2", firstKeptEntryId: "", tokensBefore: 2 },
];

test("区切りは指定 index の手前へ入り、要約済みが見えているときだけ境界を出す", () => {
  const bubbles = [bubble(1, "m1", "summarized", "a"), bubble(2, "m2", "active", "b")];
  const markers: CompactionMarker[] = [
    { id: "c1", index: 1, compactions: [COMPACTIONS[0]] },
    { id: "c2", index: 2, compactions: [COMPACTIONS[1]] },
  ];
  const items = chatRenderItems({ bubbles, markers, compactions: COMPACTIONS, activeContextStartId: "m2" });
  assert.deepEqual(
    items.map((item) => item.kind),
    ["message", "boundary", "compaction", "message", "compaction"],
  );
  assert.deepEqual(
    items.filter((item) => item.kind === "compaction").map((item) => (item.kind === "compaction" ? item.index : -1)),
    [0, 1],
  );
});

test("要約済みが見えていない / 境界が未取得なら境界ラベルを出さない", () => {
  const activeOnly = chatRenderItems({
    bubbles: [bubble(1, "m1", "active", "a")],
    markers: [],
    compactions: [],
    activeContextStartId: "m1",
  });
  assert.deepEqual(
    activeOnly.map((item) => item.kind),
    ["message"],
  );

  // 境界が古いページ側 (未取得) にあるときは、読み込んだ範囲では出さない
  const olderPage = chatRenderItems({
    bubbles: [bubble(1, "m3", "active", "a")],
    markers: [],
    compactions: [],
    activeContextStartId: "m1",
  });
  assert.deepEqual(
    olderPage.map((item) => item.kind),
    ["message"],
  );
});

test("見積りは正の値になり、ツール出力で増える", () => {
  const plain = estimateChatItemHeight({ kind: "message", key: "m", bubble: bubble(1, "m1", "active", "短い") });
  const long = estimateChatItemHeight({
    kind: "message",
    key: "m",
    bubble: {
      ...bubble(1, "m1", "active", "あ".repeat(3000)),
      tools: [{ id: "t", name: "bash", args: "", phase: "done", output: "o".repeat(2000) }],
    },
  });
  assert.ok(plain >= 72);
  assert.ok(long > plain);
  assert.ok(estimateChatItemHeight({ kind: "boundary", key: "b" }) > 0);
  assert.ok(
    estimateChatItemHeight({ kind: "compaction", key: "c", index: 0, marker: { id: "c", index: 0, compactions: [] } }) >
      0,
  );
});

test("前置き後の scrollTop は高さ増加ぶんだけ下へずらす", () => {
  assert.equal(anchoredScrollTop({ anchorTop: 0, anchorHeight: 1000, nextHeight: 1500 }), 500);
  assert.equal(anchoredScrollTop({ anchorTop: 120, anchorHeight: 1000, nextHeight: 1500 }), 620);
  // 高さが増えない (推定が変わらない) なら位置を動かさない。負にはしない
  assert.equal(anchoredScrollTop({ anchorTop: 30, anchorHeight: 1000, nextHeight: 1000 }), 30);
  assert.equal(anchoredScrollTop({ anchorTop: 0, anchorHeight: 1000, nextHeight: 900 }), 0);
});
