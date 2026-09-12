// 新規チャット (未作成チャットへ戻す) のリセットの回帰テスト。
//
// セッションは最初の送信時に作られるため、エージェント切替や「新しい会話」は
// chat state を初期値へ戻すだけになる。前の会話の実効モデル・バブル・実行状態が
// 残らないことと、bubble id (nextId) をセッション跨ぎで再利用しないことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, initialChatState } from "../src/hooks/chatReducer";
import type { SessionPayload } from "../src/types";

/** 実行中・モデル・ツール付きの resync / GET /api/sessions/:id 相当 */
function runningPayload(): SessionPayload {
  return {
    sessionId: "session-a",
    piSessionId: "pi-session-a",
    model: "stub/stub-model",
    thinkingLevel: "high",
    supportsThinking: true,
    availableThinkingLevels: ["off", "low", "high"],
    status: "running",
    title: "README をレビューして",
    createdAt: 1,
    lastUsedAt: 2,
    queueDepth: 2,
    lastSeq: 7,
    run: null,
    messages: [
      { role: "user", text: "こんにちは" },
      { role: "assistant", text: "はい" },
    ],
  };
}

/** 使用中セッションの状態 (バブル / 実行状態 / 実効モデル) */
function stateWithSession() {
  const resynced = chatReducer(initialChatState, { type: "resync", payload: runningPayload() });
  return chatReducer(resynced, {
    type: "toolStart",
    id: "tool-1",
    name: "read",
    args: "README.md",
    at: 1700000000002,
  });
}

test("新規チャットで会話状態が初期値へ戻り、実効 Model / Effort も消える", () => {
  const before = stateWithSession();
  assert.notEqual(before.bubbles.length, 0);
  assert.notEqual(before.sessionModel, undefined);

  const after = chatReducer(before, { type: "newChat" });

  assert.equal(after.bubbles.length, 0);
  assert.equal(after.currentAssistantId, null);
  assert.deepEqual(after.toolBubbleIds, {});
  assert.equal(after.runStatus, "idle");
  assert.equal(after.queueDepth, 0);
  assert.equal(after.activity, "");
  assert.equal(after.sessionModel, undefined);
  assert.equal(after.sessionThinkingLevel, undefined);
  assert.equal(after.supportsThinking, false);
  assert.deepEqual(after.availableThinkingLevels, []);
});

test("新規チャット後も bubble id を再利用しない", () => {
  const used = stateWithSession();
  const nextIdBefore = used.nextId;
  assert.notEqual(nextIdBefore, initialChatState.nextId);

  const reset = chatReducer(used, { type: "newChat" });
  assert.equal(reset.nextId, nextIdBefore);

  const afterNextMessage = chatReducer(reset, { type: "localUser", text: "次の会話", at: 1700000000003 });
  assert.equal(afterNextMessage.bubbles[0]?.id, nextIdBefore);
});

// --- メッセージ時刻 (#1281) ---

/** 履歴に at を持つ payload (リロード / resync 後はサーバーの値が正) */
function payloadWithTimes(): SessionPayload {
  const payload = runningPayload();
  payload.messages = [
    { role: "user", text: "こんにちは", at: 1700000000000 },
    { role: "assistant", text: "はい", at: 1700000001000 },
  ];
  return payload;
}

test("resync は履歴の at をバブルへ写す", () => {
  const state = chatReducer(initialChatState, { type: "resync", payload: payloadWithTimes() });
  assert.deepEqual(state.bubbles.map((bubble) => bubble.at), [1700000000000, 1700000001000]);
});

test("at を持たない履歴のバブルは at が undefined になる", () => {
  const state = chatReducer(initialChatState, { type: "resync", payload: runningPayload() });
  assert.deepEqual(state.bubbles.map((bubble) => bubble.at), [undefined, undefined]);
});

test("ローカル生成のバブルは action で受け取った時刻を使う", () => {
  const user = chatReducer(initialChatState, { type: "localUser", text: "送信中", at: 100 });
  assert.equal(user.bubbles[0]?.at, 100);

  // runStart はローカルエコー済みの user バブルを重複させない (時刻は最初のバブルのまま)
  const echoed = chatReducer(user, { type: "runStart", prompt: "送信中", at: 200 });
  assert.deepEqual(echoed.bubbles.map((bubble) => bubble.at), [100]);

  const started = chatReducer(initialChatState, { type: "runStart", prompt: "新しい会話", at: 200 });
  assert.equal(started.bubbles[0]?.at, 200);

  // 応答中のバブルは生成元イベントの時刻で作り、以後の delta では上書きしない
  const streaming = chatReducer(started, { type: "text", delta: "応答", at: 300 });
  assert.equal(streaming.bubbles[1]?.at, 300);
  const more = chatReducer(streaming, { type: "text", delta: "の続き", at: 400 });
  assert.equal(more.bubbles[1]?.at, 300);

  // 本文が無くツールだけの assistant も同じ経路で時刻を持つ
  const toolOnly = chatReducer(initialChatState, {
    type: "toolStart",
    id: "tool-1",
    name: "read",
    args: "README.md",
    at: 500,
  });
  assert.equal(toolOnly.bubbles[0]?.at, 500);
  assert.equal(toolOnly.bubbles[0]?.text, "");
});
