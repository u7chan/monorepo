// 全履歴ページと SSE resync の整合 (reducer 統合)。
// 初回 (旧 payload) → resyncHistory → 以降の resync は取得済みの古いページを消さない、を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, initialChatState } from "../src/hooks/chatReducer";
import type { HistoryPage, SessionPayload } from "../src/types";

function payload(messages: { role: "user" | "assistant"; text: string }[]): SessionPayload {
  return {
    sessionId: "session-a",
    piSessionId: "pi-session-a",
    cwd: "",
    eventGeneration: "gen-1",
    status: "idle",
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    serverNow: 1,
    queueDepth: 0,
    lastSeq: 1,
    run: null,
    messages,
    compactions: [],
  };
}

function historyPage(
  items: HistoryPage["items"],
  overrides: Partial<
    Pick<HistoryPage, "hasMore" | "nextCursor" | "messageCount" | "summarizedMessageCount" | "activeContextStartId">
  > = {},
): HistoryPage {
  const messages = items.filter((item) => item.kind === "message");
  return {
    sessionId: "session-a",
    items,
    hasMore: overrides.hasMore ?? false,
    nextCursor: overrides.nextCursor ?? null,
    activeContextStartId:
      overrides.activeContextStartId ?? messages.find((item) => item.context === "active")?.id ?? null,
    messageCount: overrides.messageCount ?? messages.length,
    summarizedMessageCount:
      overrides.summarizedMessageCount ?? messages.filter((item) => item.context === "summarized").length,
  };
}

function msg(id: string, context: "active" | "summarized" | "excluded", text: string): HistoryPage["items"][number] {
  return { kind: "message", id, context, role: "assistant", text };
}

test("resyncHistory で履歴表示へ移行し、以降の resync は古いページとエコーを残す", () => {
  // 旧 payload での初期表示 (messages ベース)
  const legacy = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "assistant", text: "m2" }]),
  });
  assert.equal(legacy.history.supported, false);
  assert.deepEqual(
    legacy.bubbles.map((bubble) => bubble.text),
    ["m2"],
  );

  // 全履歴 API の最新ページ
  const withHistory = chatReducer(legacy, {
    type: "resyncHistory",
    page: historyPage([msg("m1", "summarized", "m1"), msg("m2", "active", "m2")], {
      hasMore: true,
      nextCursor: "m1",
      messageCount: 3,
      summarizedMessageCount: 1,
    }),
  });
  assert.equal(withHistory.history.supported, true);
  assert.deepEqual(
    withHistory.bubbles.map((bubble) => [bubble.entryId, bubble.context, bubble.text]),
    [
      ["m1", "summarized", "m1"],
      ["m2", "active", "m2"],
    ],
  );

  // 送信直後 (ローカルエコー + ストリーミング中の assistant) に resync が届く
  const echoed = chatReducer(withHistory, { type: "localUser", text: "次の質問", at: 2 });
  const streaming = chatReducer(echoed, { type: "text", delta: "生成中", at: 3 });
  const resynced = chatReducer(streaming, { type: "resync", payload: payload([{ role: "assistant", text: "m2" }]) });
  assert.deepEqual(
    resynced.bubbles.map((bubble) => [bubble.entryId, bubble.text]),
    [
      ["m1", "m1"],
      ["m2", "m2"],
      [undefined, "次の質問"],
    ],
    "履歴は残り、ストリーミング中の assistant は捨て、ユーザーエコーは残る",
  );
  assert.equal(resynced.history.supported, true);
});

test("確定した応答は resync を跨いで残り、履歴ページで entryId 付きに置き換わって二重表示しない", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([msg("m1", "active", "m1"), msg("m2", "active", "m2")], {
      hasMore: true,
      nextCursor: "m1",
      messageCount: 2,
    }),
  });
  const echoed = chatReducer(base, { type: "localUser", text: "次の質問", at: 2 });
  const started = chatReducer(echoed, { type: "runStart", prompt: "次の質問", at: 2, startedAt: 2 });
  const streaming = chatReducer(started, { type: "text", delta: "生成中", at: 3 });
  const ended = chatReducer(streaming, { type: "runEnd", status: "completed", queueDepth: 0 });
  // 完了後の resync でも確定した応答を残す
  const resynced = chatReducer(ended, {
    type: "resync",
    payload: payload([
      { role: "user", text: "次の質問" },
      { role: "assistant", text: "生成中" },
    ]),
  });
  assert.deepEqual(
    resynced.bubbles.map((bubble) => `${bubble.entryId ?? "live"}:${bubble.text}`),
    ["m1:m1", "m2:m2", "live:次の質問", "live:生成中"],
  );

  // 最新ページが追いついたらライブバブルを entryId 付きへ置き換える
  const merged = chatReducer(resynced, {
    type: "resyncHistory",
    page: historyPage(
      [
        msg("m1", "active", "m1"),
        msg("m2", "active", "m2"),
        { kind: "message", id: "m3", context: "active", role: "user", text: "次の質問" },
        { kind: "message", id: "m4", context: "active", role: "assistant", text: "生成中" },
      ],
      { messageCount: 4 },
    ),
  });
  assert.deepEqual(
    merged.bubbles.map((bubble) => `${bubble.entryId ?? "live"}:${bubble.text}`),
    ["m1:m1", "m2:m2", "m3:次の質問", "m4:生成中"],
  );
});

test("prependHistory は古いページを先頭へ足し、bubble id を衝突させない", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([msg("m2", "active", "m2")], { hasMore: true, nextCursor: "m2", messageCount: 2 }),
  });
  const prepended = chatReducer(base, {
    type: "prependHistory",
    page: historyPage([msg("m1", "summarized", "m1"), msg("m2", "active", "m2")], {
      hasMore: false,
      messageCount: 2,
      summarizedMessageCount: 1,
      activeContextStartId: "m2",
    }),
  });
  assert.deepEqual(
    prepended.bubbles.map((bubble) => [bubble.entryId, bubble.context]),
    [
      ["m1", "summarized"],
      ["m2", "active"],
    ],
  );
  assert.equal(new Set(prepended.bubbles.map((bubble) => bubble.id)).size, 2);
  assert.equal(prepended.prependSeq, 1);
  assert.equal(prepended.history.hasMore, false);
});

test("旧サーバー (404) では payload.messages ベースの表示へ戻す", () => {
  const withHistory = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([msg("m1", "active", "m1")]),
  });
  const unsupported = chatReducer(withHistory, { type: "historyUnsupported" });
  assert.equal(unsupported.history.supported, false);
  const rebuilt = chatReducer(unsupported, {
    type: "resync",
    payload: payload([{ role: "user", text: "旧サーバーの履歴" }]),
  });
  assert.deepEqual(
    rebuilt.bubbles.map((bubble) => bubble.text),
    ["旧サーバーの履歴"],
  );
});

test("newChat は全履歴の状態を初期化する", () => {
  const withHistory = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([msg("m1", "active", "m1")], { hasMore: true, nextCursor: "m1" }),
  });
  const reset = chatReducer(withHistory, { type: "newChat" });
  assert.deepEqual(reset.history, initialChatState.history);
  assert.deepEqual(reset.dividers, []);
  assert.deepEqual(reset.bubbles, []);
});
