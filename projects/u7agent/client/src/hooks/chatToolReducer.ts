// ツールカード (開始 / 終了 / 進捗) と圧縮の取り込みを受け持つ。
import { toolCardOf } from "../lib/chatHistory";
import { ASK_USER_WAITING_TEXT, isPendingAskUser, pendingAskUserQuestionCount } from "../lib/askUser";
import { isToolHostBubble } from "../lib/chatTypes";
import type { ToolCall } from "../types";
import type { ChatAction, ChatState } from "../lib/chatState";
import { holdsFetchedHistory, legacyMarkers, updateBubble } from "./chatReducerShared";
import {
  attachCardTo,
  attachRunToolCards,
  closeCurrentAssistant,
  ensureToolHost,
  openAssistantForKey,
} from "./chatCards";

/**
 * 閉じたばかりの応答へツールを足せるかを決める。応答IDが違えば別の応答なので、違うカードへは
 * 足さない (本文の追記先とツールの所有者が食い違う)。
 */
function closedToolTarget(state: ChatState, assistantKey: string | undefined): number | undefined {
  if (state.currentAssistantId !== null || state.toolTargetAssistantId === undefined) return undefined;
  const target = state.bubbles.find((bubble) => bubble.id === state.toolTargetAssistantId);
  if (target === undefined) return undefined;
  const sameOwner =
    assistantKey === undefined || target.assistantId === undefined || target.assistantId === assistantKey;
  return sameOwner ? target.id : undefined;
}

/**
 * 回答が settle した直後の活動表示。待機の文言は status (由来つき) と resync (由来なし) のどちらでも
 * 入り、次に届くまで残るため、回答待ちが無くなった時点で落とす。
 */
function clearQuestionActivity(state: ChatState): ChatState {
  const waiting = state.activityState === "question" || state.activity === ASK_USER_WAITING_TEXT;
  if (!waiting || pendingAskUserQuestionCount(state.runTools, state.runStatus) > 0) {
    return state;
  }
  return { ...state, activity: "実行中…", activityState: undefined };
}

/** ツールカードと圧縮を受け持つアクション (この関数へ委譲する種別だけを抜き出す) */
type ToolChatAction = Extract<
  ChatAction,
  {
    type: "toolStart" | "toolEnd" | "toolProgress" | "compaction";
  }
>;

export function applyToolAction(state: ChatState, action: ToolChatAction): ChatState {
  switch (action.type) {
    case "toolStart": {
      if (state.thinkingText !== undefined) state = { ...state, thinkingText: undefined };
      const call: ToolCall = {
        id: action.id,
        ...(action.assistantId === undefined ? {} : { assistantId: action.assistantId }),
        name: action.name || "",
        args: action.args || "",
        isError: false,
        done: false,
        output: "",
        startedAt: action.startedAt,
        ...(action.skill ? { skill: action.skill } : {}),
        ...(action.questions ? { questions: action.questions } : {}),
      };
      /**
       * カードの置き場所: 同じ応答のバブル → assistant_end で閉じた応答 → 今ターンの host。本文を持たない
       * 応答のツールは、確定履歴が繰り上げるのと同じ持ち主になるまで 1 枚の host に溜める。
       */
      const keyTarget =
        action.assistantId === undefined
          ? undefined
          : state.bubbles.find((bubble) => bubble.role === "assistant" && bubble.assistantId === action.assistantId);
      const ended = closedToolTarget(state, action.assistantId);
      let base = state;
      let targetId = keyTarget?.id ?? ended;
      /**
       * 回答待ちの ask_user は未採用の host へ入れない (空の host は実行中だけ描画しないため、質問カードを
       * 抱えると回答手段ごと消える)。本文 item を引き取った host には同じ応答のカードとして付ける。
       */
      if (targetId !== undefined && isPendingAskUser(call)) {
        const target = state.bubbles.find((bubble) => bubble.id === targetId);
        if (target !== undefined && isToolHostBubble(target) && target.text === "") targetId = undefined;
      }
      // 応答IDを持たないツールは本文の補完先そのものへ足す
      if (targetId === undefined && action.assistantId === undefined) {
        base = openAssistantForKey(state, action.at, undefined);
        targetId = base.currentAssistantId ?? undefined;
      }
      // 保留中の run 側カードを先に補ってから新しいカードを足す (逆順だと初回のカードで
      // 新規が先頭になり、run 側の挿入順と逆のツール履歴になる)
      const withBubble = attachRunToolCards(base, false);
      const withRun = {
        ...withBubble,
        // 診断用に、今観測したツールを控える (payload 経由の復元カードと区別する)
        liveToolIds: withBubble.liveToolIds.includes(action.id)
          ? withBubble.liveToolIds
          : [...withBubble.liveToolIds, action.id],
        runTools: { ...withBubble.runTools, [action.id]: call },
      };
      if (targetId !== undefined) {
        const placed = attachCardTo(withRun, toolCardOf(call), targetId);
        // 本文を持たない応答 (item がまだ無い) の usage / metrics は表示する行が無いので捨てる
        return action.assistantId === undefined || keyTarget !== undefined
          ? placed
          : { ...placed, pendingUsage: undefined, pendingMetrics: undefined };
      }
      // 本文を持たない応答なので本文の補完先にはしない。次の表示可能な本文 item まで host に溜める
      if (action.assistantId === undefined) return withRun;
      if (isPendingAskUser(call)) {
        // 回答待ちの ask_user は本文も結果も無く履歴 item にならない。応答IDと応答メタを持つカードを
        // 合成して回答できる状態を保つ (状態行とカードの契約は docs/ask-user.md)
        const opened = openAssistantForKey(withRun, action.at, action.assistantId);
        const bubbleId = opened.currentAssistantId;
        const placed = bubbleId === null ? opened : attachCardTo(opened, toolCardOf(call), bubbleId);
        return {
          ...placed,
          // 本文の補完先にはしない (回答後の本文は新しい応答のカードで開く)
          currentAssistantId: withRun.currentAssistantId,
          currentAssistantKey: withRun.currentAssistantKey,
          toolTargetAssistantId: bubbleId ?? placed.toolTargetAssistantId,
        };
      }
      const host = ensureToolHost(closeCurrentAssistant(withRun), action.at);
      return attachCardTo(host.state, toolCardOf(call), host.id);
    }

    case "toolEnd": {
      // run 側を更新してから補完する (ページ取得がツール完了前に走っていても done / failed に揃う)
      const call = state.runTools[action.id];
      const withRun =
        call === undefined
          ? state
          : {
              ...state,
              liveToolIds: state.liveToolIds.includes(action.id)
                ? state.liveToolIds
                : [...state.liveToolIds, action.id],
              runTools: {
                ...state.runTools,
                [action.id]: {
                  ...call,
                  done: true,
                  isError: action.isError,
                  output: action.output,
                  ...(action.endedAt !== undefined ? { endedAt: action.endedAt } : {}),
                  ...(action.answers ? { answers: action.answers } : {}),
                },
              },
            };
      const bubbleId = withRun.toolBubbleIds[action.id];
      // run 側に無い call (run の無い resync 後) でも、履歴ページのカードが索引にあれば位相を反映する
      const withCard =
        bubbleId === undefined
          ? withRun
          : updateBubble(withRun, bubbleId, (b) => ({
              ...b,
              tools: b.tools.map((card) =>
                card.id === action.id
                  ? {
                      ...card,
                      phase: action.isError ? "failed" : "done",
                      output: action.output,
                      ...(action.endedAt !== undefined ? { endedAt: action.endedAt } : {}),
                      ...(action.answers ? { answers: action.answers } : {}),
                    }
                  : card,
              ),
            }));
      return clearQuestionActivity(attachRunToolCards(withCard, false));
    }

    case "toolProgress": {
      // ライブ専用の進捗。カードが無ければ作らない (resync が持ち込んだ復元カードへ後から足さない)
      const call = state.runTools[action.id];
      if (call === undefined) return state;
      return { ...state, runTools: { ...state.runTools, [action.id]: { ...call, progress: action.text } } };
    }

    case "compaction": {
      // 同じ状態を続けて resync が配る。ここでは SSE が途切れた場合にも回数と要約を残すため、
      // 1 件分を entry id で差し替える (messages の置き換えは resync が担う)。
      const index = state.compactions.findIndex((item) => item.id === action.compaction.id);
      const compactions =
        index === -1
          ? [...state.compactions, action.compaction]
          : state.compactions.map((item, i) => (i === index ? action.compaction : item));
      return {
        ...state,
        compactions,
        // 区切りの位置は次の resync の履歴ページが正。取り込み済みの履歴がある間は
        // beforeMessageIndex (payload.messages の index) では位置が合わないため触らない
        dividers: state.history.supported || holdsFetchedHistory(state) ? state.dividers : legacyMarkers(compactions),
        activity: `会話を圧縮しました（${action.count}回目）`,
        // 圧縮の通知は状態ではなく 1 回きりのお知らせなので、活動ラベルの演出は外す
        activityState: undefined,
      };
    }
  }
}
