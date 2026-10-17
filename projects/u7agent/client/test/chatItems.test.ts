// 全履歴の描画順・境界・仮想スクロールの見積り・前置き時のスクロール補正の純関数テスト。
import assert from "node:assert/strict";
import test from "node:test";
import type { Bubble, CompactionMarker } from "../src/lib/chatTypes";
import { anchoredScrollTop, chatRenderItems, estimateChatItemHeight } from "../src/lib/chatItems";
import { chatReducer, initialChatState, type ChatState } from "../src/hooks/chatReducer";
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
  // 生成バッジの行を加算する (出力の長さを揃え、バッジの分だけの差を見る)
  const output = "モデル: openai/gpt-image-2\n画像を生成して保存しました: generated/cat.png";
  const generation = estimateChatItemHeight({
    kind: "message",
    key: "m",
    bubble: {
      ...bubble(1, "m1", "active", "短い"),
      tools: [{ id: "t", name: "generate_image", args: "", phase: "done", output }],
    },
  });
  const otherTool = estimateChatItemHeight({
    kind: "message",
    key: "m",
    bubble: {
      ...bubble(1, "m1", "active", "短い"),
      tools: [{ id: "t", name: "bash", args: "", phase: "done", output }],
    },
  });
  assert.ok(generation > otherTool, "生成バッジの行を見積りに足す");
  // 生成音声のプレイヤーも加算する (結果本文の長さを揃え、プレイヤーの分だけの差を見る)
  const speech = estimateChatItemHeight({
    kind: "message",
    key: "m",
    bubble: {
      ...bubble(1, "m1", "active", "短い"),
      tools: [
        {
          id: "t",
          name: "generate_speech",
          args: "",
          phase: "done",
          output: "モデル: m\n音声を生成して保存しました: p\nこの行が続きます",
        },
      ],
    },
  });
  const image = estimateChatItemHeight({
    kind: "message",
    key: "m",
    bubble: {
      ...bubble(1, "m1", "active", "短い"),
      tools: [
        {
          id: "t",
          name: "generate_image",
          args: "",
          phase: "done",
          output: "モデル: m\n画像を生成して保存しました: p\nこの行が続きます",
        },
      ],
    },
  });
  assert.ok(speech > image, "生成音声のプレイヤーを見積りに足す");
  assert.ok(estimateChatItemHeight({ kind: "boundary", key: "b" }) > 0);
  assert.ok(
    estimateChatItemHeight({ kind: "compaction", key: "c", index: 0, marker: { id: "c", index: 0, compactions: [] } }) >
      0,
  );
});

test("結末はターンを閉じた応答に付き、値の無いターンと未送信のターンには付かない", () => {
  const valued = userTurn(1, "u1");
  // 値が無い (旧サーバー / 再起動後) ターン
  const plain: Bubble = { ...userTurn(3, "u3"), runDurationMs: undefined, runOutcome: undefined };
  // user entry が保存されなかった (未送信へ切り替わった) ターン
  const unsent = userTurn(5, "u5", { unsent: true });
  const bubbles = [
    valued,
    bubble(2, "a1", "active", "a"),
    plain,
    bubble(4, "a2", "active", "a"),
    unsent,
    bubble(6, "a3", "active", "a"),
  ];

  const items = chatRenderItems({ bubbles, markers: [], compactions: [], activeContextStartId: null });
  assert.deepEqual(
    items.map((item) => (item.kind === "message" ? `message:${item.bubble.entryId}` : item.kind)),
    ["message:u1", "message:a1", "message:u3", "message:a2", "message:u5", "message:a3"],
  );
  assert.deepEqual(
    items.filter((item) => item.kind === "message" && item.turnEnd !== undefined).map((item) => item.key),
    ["message:a1"],
    "付くのは値を持ち、未送信でもないターンの最後の応答だけ",
  );
  // 値はターンの user バブルが持ち、次の user の手前で閉じたターンの応答に写る
  const closed = items.find((item) => item.kind === "message" && item.key === "message:a1");
  assert.ok(closed?.kind === "message");
  assert.deepEqual(closed.turnEnd, { outcome: "completed", durationMs: 80_000 });
  // user バブルの無いページ (assistant だけ) は導出の相手が無い。値はサーバーが item 自身へ載せる
  assert.deepEqual(
    chatRenderItems({
      bubbles: [bubble(1, "a1", "active", "a")],
      markers: [],
      compactions: [],
      activeContextStartId: null,
    }).map((item) => (item.kind === "message" ? item.turnEnd : item.kind)),
    [undefined],
  );
});

test("item の結末はその item に付き、user バブルの無いページでも値があれば出る", () => {
  // What: 履歴ページの窓がターンより短いと user item が読み込み範囲に無いため、値は item 自身が持つ
  const answer: Bubble = {
    ...bubble(1, "a1", "active", "1 件目"),
    turnEnd: { outcome: "completed", durationMs: 80_000 },
  };
  const items = chatRenderItems({
    bubbles: [answer],
    markers: [],
    compactions: [],
    activeContextStartId: null,
  });
  const last = items.at(-1);
  assert.ok(last?.kind === "message");
  assert.deepEqual(last.turnEnd, { outcome: "completed", durationMs: 80_000 }, "user バブルが無くても出る");
});

test("item の結末は user バブル由来の導出より優先し、検査は item 自身に残す", () => {
  const fromItem: Bubble = {
    ...bubble(2, "a1", "active", "答え"),
    turnEnd: { outcome: "stopped", durationMs: 999 },
  };
  const items = chatRenderItems({
    bubbles: [userTurn(1, "u1"), fromItem],
    markers: [],
    compactions: [],
    activeContextStartId: null,
  });
  const last = items.at(-1);
  assert.ok(last?.kind === "message");
  assert.deepEqual(last.turnEnd, { outcome: "stopped", durationMs: 999 }, "item の値を上書きしない");

  // schema 上はどの message item にも載り得るため、role と本文ありの検査は表示側でも残す
  const guarded = chatRenderItems({
    bubbles: [
      { ...userTurn(3, "u3"), turnEnd: { outcome: "completed", durationMs: 80_000 } },
      { ...bubble(4, "a2", "active", ""), turnEnd: { outcome: "completed", durationMs: 80_000 } },
    ],
    markers: [],
    compactions: [],
    activeContextStartId: null,
  });
  assert.deepEqual(
    guarded.map((item) => (item.kind === "message" ? item.turnEnd : item.kind)),
    [undefined, undefined],
    "user item / 本文の無い応答には出ない",
  );
});

test("本文を持つ応答が無いターンには結末を付けない", () => {
  // What: ツールだけのターンはライブでは本文が空の assistant バブルを持つため、
  // 「assistant であること」だけでは足りない (履歴では表示メッセージにならず、見え方が食い違う)
  assert.deepEqual(
    chatRenderItems({
      bubbles: [userTurn(1, "u1")],
      markers: [],
      compactions: [],
      activeContextStartId: null,
    }).map((item) => (item.kind === "message" ? item.turnEnd : item.kind)),
    [undefined],
    "応答のバブルが無いターン",
  );
  const toolOnly: Bubble = {
    ...bubble(2, "a1", "active", ""),
    entryId: undefined,
    at: 1_700_000_000_000,
    tools: [{ id: "t", name: "bash", args: "", phase: "done", output: "o" }],
  };
  assert.deepEqual(
    chatRenderItems({
      bubbles: [userTurn(1, "u1"), toolOnly],
      markers: [],
      compactions: [],
      activeContextStartId: null,
    }).map((item) => (item.kind === "message" ? item.turnEnd : item.kind)),
    [undefined, undefined],
    "本文が空の応答 (ライブのツールだけのターン)",
  );
  // 本文が 1 文字でもあれば、そのターンの結末として付く
  const items = chatRenderItems({
    bubbles: [userTurn(1, "u1"), bubble(2, "a1", "active", "結果です")],
    markers: [],
    compactions: [],
    activeContextStartId: null,
  });
  const last = items.at(-1);
  assert.ok(last?.kind === "message" && last.turnEnd !== undefined, "本文を持つ応答には付く");
});

test("ライブのツールだけのターンは reducer から通しても結末が付かない", () => {
  // What: toolStart が本文の空な assistant バブルを作り、runEnd が同じターンの user へ値を写す経路を固定する
  const steps: ((chat: ChatState) => ChatState)[] = [
    (chat) => chatReducer(chat, { type: "localUser", text: "調べて", at: 100 }),
    (chat) => chatReducer(chat, { type: "echoRunId", runId: "r1" }),
    (chat) => chatReducer(chat, { type: "runStart", runId: "r1", prompt: "調べて", at: 100, startedAt: 100 }),
    (chat) => chatReducer(chat, { type: "toolStart", id: "t1", name: "bash", args: "{}", at: 150 }),
    (chat) => chatReducer(chat, { type: "toolEnd", id: "t1", isError: false, output: "done" }),
  ];
  const started = steps.reduce((chat, step) => step(chat), initialChatState);
  const ended = (chat: ChatState): ChatState =>
    chatReducer(chat, { type: "runEnd", runId: "r1", status: "completed", queueDepth: 0, durationMs: 1234 });
  const turnEnds = (chat: ChatState): string[] =>
    chatRenderItems({ bubbles: chat.bubbles, markers: [], compactions: [], activeContextStartId: null })
      .filter((item) => item.kind === "message" && item.turnEnd !== undefined)
      .map((item) => item.key);

  assert.deepEqual(turnEnds(ended(started)), [], "本文が空の応答 (ツールだけ) には付かない");
  const withText = chatReducer(started, { type: "text", delta: "結果です", at: 160 });
  assert.deepEqual(turnEnds(ended(withText)), ["message:2"], "本文が届いた応答には付く");
});

test("結末はターンを閉じた応答に残り、次のターンの境界ラベル・圧縮の区切りより前に出る", () => {
  const user = userTurn(1, "u1", { context: "summarized" });
  const next = userTurn(3, "u3");
  const bubbles = [user, bubble(2, "a1", "summarized", "a"), next];
  const markers: CompactionMarker[] = [{ id: "c1", index: 2, compactions: [COMPACTIONS[0]] }];

  const items = chatRenderItems({ bubbles, markers, compactions: COMPACTIONS, activeContextStartId: "u3" });
  assert.deepEqual(
    items.map((item) => (item.kind === "message" ? `message:${item.bubble.entryId}` : item.kind)),
    ["message:u1", "message:a1", "boundary", "compaction", "message:u3"],
  );
  const closed = items.find((item) => item.kind === "message" && item.key === "message:a1");
  assert.ok(closed?.kind === "message" && closed.turnEnd !== undefined, "ターンを閉じた応答に付く");
  const last = items.at(-1);
  assert.ok(last?.kind === "message" && last.turnEnd === undefined, "次のターンの応答には付かない");
});

test("entryId の無いライブのターンでも、結末は最後の応答に付きキーが安定する", () => {
  const live: Bubble = {
    ...userTurn(7, "ignored", { entryId: undefined }),
    runOutcome: "stopped",
    runDurationMs: 999,
  };
  const answer: Bubble = { ...bubble(8, "ignored", "active", "a"), entryId: undefined };
  const items = chatRenderItems({ bubbles: [live, answer], markers: [], compactions: [], activeContextStartId: null });
  const last = items.at(-1);
  assert.ok(last?.kind === "message");
  assert.equal(last.key, "message:8", "entryId が無くてもキーが安定する");
  assert.deepEqual(last.turnEnd, { outcome: "stopped", durationMs: 999 });
});

test("待機中の送信は transcript に並ばず、圧縮の区切りと境界の位置をずらさない", () => {
  // What: 待機中はコンポーザー直上のブロックが担うため、描画の配列からは外す。ただし区切りの index と
  // 境界の位置は bubbles の位置で決まるので、外した分だけ後ろへずれてはいけない
  const waiting: Bubble = {
    id: 3,
    role: "user",
    text: "待機の本文",
    tools: [],
    skillLoads: [],
    queued: true,
    runId: "run-q",
  };
  const bubbles = [
    bubble(1, "u1", "summarized", "a"),
    userTurn(2, "u2", { context: "summarized" }),
    waiting,
    bubble(4, "a2", "active", "結果"),
  ];
  const markers: CompactionMarker[] = [{ id: "c1", index: 2, compactions: [COMPACTIONS[0]] }];

  const items = chatRenderItems({ bubbles, markers, compactions: COMPACTIONS, activeContextStartId: "a2" });

  assert.deepEqual(
    items.map((item) => (item.kind === "message" ? `message:${item.bubble.id}` : item.kind)),
    ["message:1", "message:2", "compaction", "boundary", "message:4"],
    "待機のバブルは並ばず、区切りと境界は待機の直前の位置のまま",
  );
  assert.equal(items.filter((item) => item.kind === "message").length, 3, "待機中の送信は message item を作らない");
});

test("待機を挟んだターンの結末は、そのターンの最後の応答にだけ付く", () => {
  // What: 待機のバブルはターンの区切りに使わない。前のターンの結末はそのターンの応答へ付き、
  // 待機のターンの結末 (まだ実行されていない) は次の応答に漏れない
  const waiting: Bubble = {
    id: 3,
    role: "user",
    text: "待機の本文",
    tools: [],
    skillLoads: [],
    queued: true,
    runId: "run-q",
  };
  const bubbles = [
    userTurn(1, "u1", { runDurationMs: 1000, runOutcome: "completed" }),
    bubble(2, "a1", "active", "応答1"),
    waiting,
    bubble(4, "a2", "active", "応答2"),
  ];

  const items = chatRenderItems({ bubbles, markers: [], compactions: [], activeContextStartId: null });

  const ends = items.filter((item) => item.kind === "message" && item.turnEnd !== undefined);
  assert.deepEqual(
    ends.map((item) => (item.kind === "message" ? item.key : "")),
    ["message:a1"],
    "結末は実行が終わったターンの最後の応答にだけ付く",
  );
  assert.deepEqual(
    items.map((item) => (item.kind === "message" ? item.bubble.id : item.kind)),
    [1, 2, 4],
  );
});

test("前置き後の scrollTop は高さ増加ぶんだけ下へずらす", () => {
  assert.equal(anchoredScrollTop({ anchorTop: 0, anchorHeight: 1000, nextHeight: 1500 }), 500);
  assert.equal(anchoredScrollTop({ anchorTop: 120, anchorHeight: 1000, nextHeight: 1500 }), 620);
  // 高さが増えない (推定が変わらない) なら位置を動かさない。負にはしない
  assert.equal(anchoredScrollTop({ anchorTop: 30, anchorHeight: 1000, nextHeight: 1000 }), 30);
  assert.equal(anchoredScrollTop({ anchorTop: 0, anchorHeight: 1000, nextHeight: 900 }), 0);
});
