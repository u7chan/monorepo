// assistant ヘッダーの生成モデル表示の検証。DOM 基盤が無いため react-dom/server の静的描画で固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chatReducer, initialChatState, type ChatState } from "../src/hooks/chatReducer";
import type { Bubble } from "../src/lib/chatTypes";
import type { HistoryPage, SessionPayload } from "../src/types";

// MessageView は AttachedFiles 経由で api.ts (location.origin を読む) を辿るため、先に shim を置く
globalThis.location ??= { origin: "http://localhost" } as Location;
const { MessageView } = await import("../src/components/chat/MessageView");

const ASSISTANT_ID = "run-1:1";
const ANSWER = "回答です";
const MODEL = "example/model-a";

function payload(): SessionPayload {
  return {
    sessionId: "s-1",
    piSessionId: "pi-s-1",
    cwd: "",
    eventGeneration: "gen-1",
    status: "running",
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    serverNow: 1,
    queueDepth: 0,
    pinned: false,
    lastSeq: 1,
    run: null,
    messages: [],
    compactions: [],
  };
}

function historyPage(): HistoryPage {
  return {
    sessionId: "s-1",
    items: [
      { kind: "message", id: "m1", context: "active", role: "user", text: "質問です" },
      {
        kind: "message",
        id: "m2",
        context: "active",
        role: "assistant",
        text: ANSWER,
        assistantId: ASSISTANT_ID,
        model: MODEL,
      },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "m1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
}

/** 本文の delta まで受信したライブ応答 (assistant_end はまだ) */
function streaming(): ChatState {
  let state = chatReducer(initialChatState, { type: "resync", payload: payload() });
  state = chatReducer(state, { type: "runStart", runId: "run-1", prompt: "質問です", at: 1, startedAt: 1 });
  return chatReducer(state, { type: "text", delta: ANSWER, at: 2, assistantId: ASSISTANT_ID });
}

function answeredBubble(state: ChatState): Bubble {
  const bubble = state.bubbles.find((candidate) => candidate.role === "assistant" && candidate.text === ANSWER);
  assert.ok(bubble !== undefined, "応答のバブルがある");
  return bubble;
}

function render(bubble: Bubble, modelLabel?: string): string {
  return renderToStaticMarkup(
    createElement(MessageView, {
      bubble,
      skillBadges: [],
      copied: false,
      singleColumn: false,
      rootCwd: "/workspace",
      onCopy: () => {},
      copiedId: "",
      copyFailure: () => undefined,
      onCopyTool: () => {},
      copiedAll: false,
      onCopyAll: () => {},
      ...(modelLabel === undefined ? {} : { modelLabel }),
    }),
  );
}

test("履歴が assistant_end を追い越しても、確定まではモデルを出さず、確定後に出す", () => {
  // What: history の item が同じ assistantId と model を持っていても、未確定のライブ応答は
  // assistant_end までバッジを伏せ、確定後に同じ値で出す
  const live = chatReducer(streaming(), { type: "resyncHistory", page: historyPage() });
  const pending = answeredBubble(live);
  assert.equal(pending.assistantId, ASSISTANT_ID, "ライブの応答へ履歴を対応付ける");
  assert.equal(pending.settled, undefined, "まだ確定していない");
  assert.equal(pending.model, undefined, "履歴のモデルを未確定のライブ応答へ写さない");
  const pendingHtml = render(pending, "Model A");
  assert.doesNotMatch(pendingHtml, /Model A/, "ストリーミング中は表示名を出さない");
  assert.doesNotMatch(pendingHtml, /example\/model-a/, "ストリーミング中は識別子も出さない");

  const ended = chatReducer(live, { type: "assistantEnd", assistantId: ASSISTANT_ID, model: MODEL });
  const settled = answeredBubble(ended);
  assert.equal(settled.model, MODEL, "assistant_end の値で確定する");
  const html = render(settled, "Model A");
  assert.match(html, /Model A/, "確定後は候補の name を出す");
  assert.ok(html.includes(`title="${MODEL}"`), "tooltip は provider/id だけ");
  assert.doesNotMatch(html, /選択モデル/, "tooltip にラベルを付けない");
});

test("モデルは表示名 → provider/id の順に解決し、null は不明、未指定は出さない", () => {
  // What: 候補に無いモデルは provider/id を出し、null (モデル情報なし) は「モデル不明」、
  // キー省略 (旧サーバー / assistant_end 前) はバッジごと出さない
  const bubble = answeredBubble(streaming());

  const resolved = render({ ...bubble, model: MODEL }, "Model A");
  assert.match(resolved, /Model A/);
  assert.ok(resolved.includes(`title="${MODEL}"`));

  const unresolved = render({ ...bubble, model: MODEL });
  assert.match(unresolved, /example\/model-a/);
  assert.ok(unresolved.includes(`title="${MODEL}"`));

  const unknown = render({ ...bubble, model: null });
  assert.match(unknown, /モデル不明/);
  assert.doesNotMatch(unknown, /example\//);

  const hidden = render(bubble);
  assert.doesNotMatch(hidden, /モデル不明|example\//);
  assert.ok(!hidden.includes(`title="${MODEL}"`), "モデルの tooltip を出さない");
});
