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

  const afterNextMessage = chatReducer(reset, { type: "localUser", text: "次の会話" });
  assert.equal(afterNextMessage.bubbles[0]?.id, nextIdBefore);
});
