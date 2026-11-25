// 操作の結果 (notice)・活動行・開始演出の回帰テスト。
import assert from "node:assert/strict";
import test from "node:test";
import { initialChatState } from "../src/lib/chatState";
import { chatReducer } from "../src/hooks/chatReducer";
import type { SessionPayload } from "../src/types";

/** 実行中・モデル・ツール付きの resync / GET /api/sessions/:id 相当 */
function runningPayload(): SessionPayload {
  return {
    sessionId: "session-a",
    piSessionId: "pi-session-a",
    cwd: "",
    eventGeneration: "gen-1",
    model: "stub/stub-model",
    thinkingLevel: "high",
    supportsThinking: true,
    availableThinkingLevels: ["off", "low", "high"],
    status: "running",
    title: "README をレビューして",
    createdAt: 1,
    lastUsedAt: 2,
    serverNow: 2,
    queueDepth: 2,
    pinned: false,
    lastSeq: 7,
    run: null,
    messages: [
      { role: "user", text: "こんにちは" },
      { role: "assistant", text: "はい" },
    ],
    compactions: [],
  };
}

test("操作の結果 (notice) は応答や同じ会話の resync では消えず、操作の開始と会話の切替で消える", () => {
  // What: 取り消しの失敗理由などを活動文言とは別に持ち、後続の status / resync の活動文言に
  // 上書きされないこと、保持を解く契機を固定する。解除は「利用者の操作の開始 (clearNotice)」と
  // 「会話の切替」だけで、送信のエコー (localUser) や応答 (setRun / queueCanceled) では消さない
  // (先に始めた要求の後着応答が、後から出た別の結果を消す経路を閉じる)
  const resynced = chatReducer(initialChatState, { type: "resync", payload: runningPayload() });
  const noticed = chatReducer(resynced, { type: "notice", text: "待機中のメッセージが見つかりません" });

  const statused = chatReducer(noticed, { type: "status", state: "thinking", text: "考え中…" });
  assert.equal(statused.activity, "考え中…", "活動文言は活動行のまま更新する");
  assert.equal(statused.notice, "待機中のメッセージが見つかりません");

  const resyncedAgain = chatReducer(statused, { type: "resync", payload: runningPayload() });
  assert.equal(resyncedAgain.notice, "待機中のメッセージが見つかりません", "同じ会話の取り直しでは残す");

  const ended = chatReducer(resyncedAgain, { type: "runEnd", status: "completed", queueDepth: 0 });
  assert.equal(ended.activity, "完了");
  assert.equal(ended.notice, "待機中のメッセージが見つかりません", "終端の活動文言でも消さない");

  // 応答・エコー (取消より前に始めた要求の後着) では消さない
  const echoed = chatReducer(ended, { type: "localUser", text: "先に押していた送信", at: 1700000000003 });
  assert.equal(echoed.notice, "待機中のメッセージが見つかりません", "先行要求のエコーで消さない");
  const responded = chatReducer(echoed, { type: "setRun", runStatus: "running", activity: "実行中…" });
  assert.equal(responded.notice, "待機中のメッセージが見つかりません", "先行要求の応答で消さない");

  const cleared = chatReducer(responded, { type: "clearNotice" });
  assert.equal(cleared.notice, undefined, "操作の開始で用済みにする");
  assert.equal(cleared.activity, "実行中…", "解除しても活動文言は触らない");

  const switched = chatReducer(chatReducer(cleared, { type: "notice", text: "待機中のメッセージが見つかりません" }), {
    type: "resync",
    payload: { ...runningPayload(), sessionId: "session-b", piSessionId: "pi-session-b" },
  });
  assert.equal(switched.sessionId, "session-b");
  assert.equal(switched.notice, undefined, "会話を切り替えたら残さない");
});
