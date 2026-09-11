// ヘッダーのモデル表示の回帰テスト。
//
// リロード時は health (サーバー既定モデル) → セッション復元 (会話モデル) →
// health 再取得の順に応答が届く。ヘッダーの表示は選択中セッションの実効モデル
// (resync が chat.sessionModel に入れる値) に従い、後から届いた health の既定
// モデルへ化けないこと、会話モデルとアプリ既定モデルを取り違えないことを
// reducer と表示導出を通して検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, initialChatState, type ChatState } from "../src/hooks/chatReducer";
import { MODEL_DISPLAY_LABELS, modelDisplayOf } from "../src/hooks/modelDisplay";
import type { SessionPayload } from "../src/types";

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const SESSION_MODEL = "openai/gpt-5.6-luna";

/** GET /api/sessions/:id / resync イベントのペイロード (実効モデル入り) */
function payload(model?: string): SessionPayload {
  return {
    sessionId: "session-a",
    piSessionId: "pi-session-a",
    model,
    status: "idle",
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    queueDepth: 0,
    lastSeq: 1,
    run: null,
    messages: [],
  };
}

/** useAgentDesk と同じ入力でヘッダー表示を導出する (状態は持たない) */
function displayAfterSnapshot(state: ChatState, defaultModel?: string) {
  return modelDisplayOf({ inSession: true, sessionModel: state.sessionModel, defaultModel });
}

test("セッション復元後は health の既定モデルではなく会話モデルを表示する", () => {
  const restored = chatReducer(initialChatState, { type: "resync", payload: payload(SESSION_MODEL) });

  // 起動時とリロード後の health は既定モデルを返す。表示はそれに引きずられない。
  for (const defaultModel of [DEFAULT_MODEL, "anthropic/claude-sonnet-4-5"]) {
    const display = displayAfterSnapshot(restored, defaultModel);
    assert.equal(display?.model, SESSION_MODEL, `既定 ${defaultModel} でも会話モデルのまま`);
    assert.equal(display?.source, "session");
    assert.equal(display?.label, MODEL_DISPLAY_LABELS.session);
  }
});

test("会話モデルが取れないセッションでも既定モデルへフォールバックしない", () => {
  const restored = chatReducer(initialChatState, { type: "resync", payload: payload(undefined) });
  assert.equal(displayAfterSnapshot(restored, DEFAULT_MODEL), undefined);
});

test("会話を切り替えると表示モデルも切り替わる", () => {
  const switched = chatReducer(initialChatState, { type: "resync", payload: payload("stub/stub-plain") });
  const display = displayAfterSnapshot(switched, DEFAULT_MODEL);
  assert.equal(display?.model, "stub/stub-plain");
  assert.equal(display?.source, "session");
});

test("未作成のチャットはアプリ既定を「既定」と明示して表示する", () => {
  const display = modelDisplayOf({
    inSession: false,
    // 直前まで開いていたセッションのモデルは未作成チャットへ持ち越さない
    sessionModel: SESSION_MODEL,
    defaultModel: DEFAULT_MODEL,
  });
  assert.equal(display?.model, DEFAULT_MODEL);
  assert.equal(display?.source, "default");
  assert.equal(display?.label, MODEL_DISPLAY_LABELS.default);
  assert.notEqual(display?.label, MODEL_DISPLAY_LABELS.session);
});

test("セッションも既定モデルも無いときは何も表示しない", () => {
  assert.equal(modelDisplayOf({ inSession: false }), undefined);
});
