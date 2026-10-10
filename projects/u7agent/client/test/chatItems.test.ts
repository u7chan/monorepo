// 全履歴の描画順・境界・仮想スクロールの見積り・前置き時のスクロール補正の純関数テスト。
import assert from "node:assert/strict";
import test from "node:test";
import type { Bubble, CompactionMarker } from "../src/lib/chatTypes";
import { anchoredScrollTop, chatRenderItems, estimateChatItemHeight } from "../src/lib/chatItems";
import type { CompactionInfo } from "../src/types";

function bubble(id: number, entryId: string, context: Bubble["context"], text: string): Bubble {
  return { id, entryId, context, role: "assistant", text, tools: [], skillLoads: [] };
}

/** 値を付けた user バブル (そのターンの終端行の根拠) */
function userTurn(id: number, entryId: string, extra: Partial<Bubble> = {}): Bubble {
  return {
    id,
    entryId,
    context: "active",
    role: "user",
    text: `turn-${id}`,
    tools: [],
    skillLoads: [],
    runId: `run-${id}`,
    runDurationMs: 80_000,
    runOutcome: "completed",
    ...extra,
  };
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

test("終端行は次の user の手前と末尾に出て、値の無いターンと未送信のターンには出ない", () => {
  const valued = userTurn(1, "u1");
  // 値が無い (旧サーバー / 再起動後) ターン
  const plain: Bubble = { ...userTurn(3, "u3"), runDurationMs: undefined, runOutcome: undefined };
  // user entry が保存されなかった (未送信へ切り替わった) ターン
  const unsent = userTurn(5, "u5", { unsent: true });
  const bubbles = [valued, bubble(2, "a1", "active", "a"), plain, bubble(4, "a2", "active", "a"), unsent];

  const items = chatRenderItems({ bubbles, markers: [], compactions: [], activeContextStartId: null });
  assert.deepEqual(
    items.map((item) => (item.kind === "message" ? `message:${item.bubble.entryId}` : item.kind)),
    [
      "message:u1",
      "message:a1",
      // 次の user (u3) の手前で 1 つ目のターンを閉じる
      "turn-end",
      "message:u3",
      "message:a2",
      // 値の無い plain のターンは行を出さない (u5 の手前)
      "message:u5",
      // 未送信のターン (u5) でも行を出さない (末尾)
    ],
  );
  const turnEnds = items.filter((item) => item.kind === "turn-end");
  assert.deepEqual(
    turnEnds.map((item) => item.key),
    ["turn-end:u1"],
  );
  // 位置は次の user item の手前 / (最後の行は) 末尾
  assert.equal(items.at(-1)?.kind, "message");
  assert.deepEqual(
    chatRenderItems({
      bubbles: [bubble(1, "a1", "active", "a")],
      markers: [],
      compactions: [],
      activeContextStartId: null,
    }).map((item) => item.kind),
    ["message"],
    "user の居ない範囲には終端行を出さない",
  );
});

test("終端行は境界ラベル・圧縮の区切りより先に出る", () => {
  const user = userTurn(1, "u1", { context: "summarized" });
  const next = userTurn(3, "u3");
  const bubbles = [user, bubble(2, "a1", "summarized", "a"), next];
  const markers: CompactionMarker[] = [{ id: "c1", index: 2, compactions: [COMPACTIONS[0]] }];

  const items = chatRenderItems({ bubbles, markers, compactions: COMPACTIONS, activeContextStartId: "u3" });
  assert.deepEqual(
    items.map((item) => (item.kind === "message" ? `message:${item.bubble.entryId}` : item.kind)),
    ["message:u1", "message:a1", "turn-end", "boundary", "compaction", "message:u3", "turn-end"],
  );
  // 薄暗さはそのターンの item (summarized) に合わせる
  assert.deepEqual(
    items.filter((item) => item.kind === "turn-end").map((item) => item.summarized),
    [true, false],
  );
});

test("ライブのターン終端は bubble.id をキーにし、見積りは正の値になる", () => {
  const live: Bubble = {
    ...userTurn(7, "ignored", { entryId: undefined }),
    runOutcome: "stopped",
    runDurationMs: 999,
  };
  const items = chatRenderItems({ bubbles: [live], markers: [], compactions: [], activeContextStartId: null });
  const turnEnd = items.find((item) => item.kind === "turn-end");
  if (turnEnd?.kind !== "turn-end") throw new Error("ターン終端の item が出ていない");
  assert.equal(turnEnd.key, "turn-end:7", "entryId が無くてもキーが安定する");
  assert.equal(turnEnd.outcome, "stopped");
  assert.equal(turnEnd.durationMs, 999);
  assert.ok(estimateChatItemHeight(turnEnd) > 0);
});

test("前置き後の scrollTop は高さ増加ぶんだけ下へずらす", () => {
  assert.equal(anchoredScrollTop({ anchorTop: 0, anchorHeight: 1000, nextHeight: 1500 }), 500);
  assert.equal(anchoredScrollTop({ anchorTop: 120, anchorHeight: 1000, nextHeight: 1500 }), 620);
  // 高さが増えない (推定が変わらない) なら位置を動かさない。負にはしない
  assert.equal(anchoredScrollTop({ anchorTop: 30, anchorHeight: 1000, nextHeight: 1000 }), 30);
  assert.equal(anchoredScrollTop({ anchorTop: 0, anchorHeight: 1000, nextHeight: 900 }), 0);
});
