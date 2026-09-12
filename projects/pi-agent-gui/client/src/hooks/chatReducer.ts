import type { ChatMessage, RunStatus, SessionPayload, ThinkingLevel, ToolCall } from "../types";

export type ToolPhase = "running" | "done" | "failed";

export type ToolCard = {
  /** サーバー発イベントの toolCall id (ローカル生成時は採番) */
  id: string;
  name: string;
  args: string;
  phase: ToolPhase;
  output: string;
};

export type Bubble = {
  id: number;
  role: "user" | "assistant";
  text: string;
  tools: ToolCard[];
  /** メッセージの作成時刻 (epoch ms)。履歴に時刻が無い場合は undefined */
  at?: number;
};

export type ChatState = {
  bubbles: Bubble[];
  nextId: number;
  /** 開いている assistant バブル */
  currentAssistantId: number | null;
  /** toolCall id -> バブル id (tool_end でカードを引くため) */
  toolBubbleIds: Record<string, number>;
  runStatus: RunStatus;
  queueDepth: number;
  activity: string;
  /** サーバーが返した実効モデル (provider/id)。未作成のチャットでは undefined */
  sessionModel?: string;
  /** サーバー補正後の実効 Effort */
  sessionThinkingLevel?: string;
  /** 実効モデルが推論に対応しているか */
  supportsThinking: boolean;
  /** 実効モデルで選べる Effort の候補 (非推論は ["off"] のみ) */
  availableThinkingLevels: ThinkingLevel[];
};

export type ChatAction =
  | { type: "newChat" }
  | { type: "resync"; payload: SessionPayload }
  | { type: "runStart"; prompt: string; at: number }
  | { type: "localUser"; text: string; at: number }
  | { type: "text"; delta: string; at: number }
  | { type: "toolStart"; id: string; name: string; args: string; at: number }
  | { type: "toolEnd"; id: string; isError: boolean; output: string }
  | { type: "status"; text: string }
  | { type: "queued"; position: number; queueDepth: number }
  | { type: "queueCleared" }
  | { type: "runEnd"; status: RunStatus; queueDepth: number; error?: string }
  | { type: "setRun"; runStatus: RunStatus; queueDepth?: number; activity?: string }
  | { type: "setActivity"; text: string };

export const initialChatState: ChatState = {
  bubbles: [],
  nextId: 1,
  currentAssistantId: null,
  toolBubbleIds: {},
  runStatus: "idle",
  queueDepth: 0,
  activity: "",
  sessionModel: undefined,
  sessionThinkingLevel: undefined,
  supportsThinking: false,
  availableThinkingLevels: [],
};

function appendBubble(state: ChatState, role: Bubble["role"], text = "", at?: number): ChatState {
  const bubble: Bubble = { id: state.nextId, role, text, tools: [], at };
  return {
    ...state,
    bubbles: [...state.bubbles, bubble],
    nextId: state.nextId + 1,
  };
}

function updateBubble(state: ChatState, id: number, update: (bubble: Bubble) => Bubble): ChatState {
  return { ...state, bubbles: state.bubbles.map((b) => (b.id === id ? update(b) : b)) };
}

function patchAssistant(
  state: ChatState,
  update: (bubble: Bubble) => Bubble,
): ChatState {
  if (state.currentAssistantId === null) return state;
  return updateBubble(state, state.currentAssistantId, update);
}

/** 開いている assistant バブルを返す (なければ新規作成)。at は生成元イベントの時刻 */
function ensureAssistant(state: ChatState, at?: number): ChatState {
  if (state.currentAssistantId !== null && state.bubbles.some((b) => b.id === state.currentAssistantId)) {
    return state;
  }
  const next = appendBubble(state, "assistant", "", at);
  return { ...next, currentAssistantId: next.nextId - 1 };
}

function addToolCard(state: ChatState, card: ToolCard, at?: number): ChatState {
  const withBubble = ensureAssistant(state, at);
  const bubbleId = withBubble.currentAssistantId as number;
  return {
    ...updateBubble(withBubble, bubbleId, (b) => ({ ...b, tools: [...b.tools, card] })),
    toolBubbleIds: { ...withBubble.toolBubbleIds, [card.id]: bubbleId },
  };
}

function historyToBubbles(nextId: number, messages: ChatMessage[]): { bubbles: Bubble[]; nextId: number } {
  const bubbles: Bubble[] = messages.map((message) => ({
    id: nextId++,
    role: message.role,
    text: message.text,
    tools: [],
    at: message.at,
  }));
  return { bubbles, nextId };
}

/** run.toolCalls をツールカードに変換してバブルへ付ける */
function attachToolCalls(state: ChatState, bubbleId: number, toolCalls: ToolCall[]): ChatState {
  let next = state;
  for (const call of toolCalls) {
    const card: ToolCard = {
      id: call.id,
      name: call.name,
      args: call.args,
      phase: call.done ? (call.isError ? "failed" : "done") : "running",
      output: call.output,
    };
    next = {
      ...updateBubble(next, bubbleId, (b) => ({ ...b, tools: [...b.tools, card] })),
      toolBubbleIds: { ...next.toolBubbleIds, [call.id]: bubbleId },
    };
  }
  return next;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "newChat":
      // 未作成チャットは sessionModel 等の実効値を持たず、表示は composerSettings が担う。
      // nextId だけは引き継ぐ (セッションを跨いで古いイベントの bubble id と衝突させない)。
      return { ...initialChatState, nextId: state.nextId };

    case "resync": {
      const payload = action.payload;
      const { bubbles, nextId } = historyToBubbles(state.nextId, payload.messages ?? []);
      let next: ChatState = {
        ...state,
        bubbles,
        nextId,
        currentAssistantId: null,
        toolBubbleIds: {},
        runStatus: payload.status || "idle",
        queueDepth: payload.queueDepth || 0,
        activity: "",
        sessionModel: payload.model,
        sessionThinkingLevel: payload.thinkingLevel,
        supportsThinking: payload.supportsThinking ?? false,
        availableThinkingLevels: payload.availableThinkingLevels ?? [],
      };
      if (payload.run?.toolCalls?.length && (payload.status === "running" || payload.status === "completed")) {
        const last = [...bubbles].reverse().find((b) => b.role === "assistant");
        if (last) {
          next = attachToolCalls(next, last.id, payload.run.toolCalls);
          next = { ...next, currentAssistantId: payload.status === "running" ? last.id : null };
        }
      }
      if (payload.status === "running") next = { ...next, activity: "実行中…（タブを閉じても処理は続きます）" };
      else if (payload.status === "queued") next = { ...next, activity: `待機中のメッセージがあります（${payload.queueDepth}件）` };
      else if (payload.status === "error") next = { ...next, activity: "前回の実行でエラーが発生しました" };
      else if (payload.status === "stopped") next = { ...next, activity: "前回の実行は停止されました" };
      return next;
    }

    case "runStart": {
      // ローカルエコー済みなら user バブルを重複させない
      const lastUser = [...state.bubbles].reverse().find((b) => b.role === "user");
      const next = lastUser?.text === action.prompt ? state : appendBubble(state, "user", action.prompt, action.at);
      return {
        ...next,
        currentAssistantId: null,
        toolBubbleIds: {},
        runStatus: "running",
        activity: "実行を開始しました",
      };
    }

    case "localUser": {
      const next = appendBubble(state, "user", action.text, action.at);
      return { ...next, currentAssistantId: null, activity: "送信中…" };
    }

    case "text": {
      const withBubble = ensureAssistant(state, action.at);
      return patchAssistant(withBubble, (b) => ({ ...b, text: b.text + (action.delta || "") }));
    }

    case "toolStart":
      return addToolCard(
        state,
        {
          id: action.id,
          name: action.name || "",
          args: action.args || "",
          phase: "running",
          output: "",
        },
        action.at,
      );

    case "toolEnd": {
      const bubbleId = state.toolBubbleIds[action.id];
      if (bubbleId === undefined) return state;
      return updateBubble(state, bubbleId, (b) => ({
        ...b,
        tools: b.tools.map((card) =>
          card.id === action.id
            ? { ...card, phase: action.isError ? "failed" : "done", output: action.output }
            : card,
        ),
      }));
    }

    case "status":
      return { ...state, activity: action.text || "処理中…" };

    case "queued":
      return {
        ...state,
        runStatus: "running",
        queueDepth: action.queueDepth,
        activity: `実行中のため待機キューに追加しました（${action.position}件目）`,
      };

    case "queueCleared":
      return { ...state, queueDepth: 0, activity: "待機キューを取り消しました" };

    case "runEnd": {
      const { status, queueDepth } = action;
      let activity: string;
      if (status === "stopped") activity = "停止しました";
      else if (status === "error") activity = `エラー: ${action.error || "実行に失敗しました"}`;
      else activity = queueDepth > 0 ? "完了。次のメッセージを実行します" : "完了";
      return {
        ...state,
        currentAssistantId: null,
        toolBubbleIds: {},
        activity,
        runStatus: queueDepth > 0 ? "queued" : status === "completed" ? "idle" : status,
        queueDepth,
      };
    }

    case "setRun":
      return {
        ...state,
        runStatus: action.runStatus,
        queueDepth: action.queueDepth ?? state.queueDepth,
        activity: action.activity ?? state.activity,
      };

    case "setActivity":
      return { ...state, activity: action.text };
  }
}
