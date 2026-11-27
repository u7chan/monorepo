// 送信キュー (待機の位置 / 取り消し / エコーと送信IDの対応付け / 再送) を受け持つ。
import { newestHistoryItemId } from "../lib/chatHistory";
import type { Bubble } from "../lib/chatTypes";
import type { ChatAction, ChatState } from "../lib/chatState";
import {
  CLEARED_TURN_END,
  QUEUE_CLEARED,
  UNSENT_CLEARED,
  appendBubble,
  updateBubble,
  withoutQueuedSnapshots,
} from "./chatReducerShared";

/**
 * 応答 (`echoSendId`) が結び付ける待機の順位。応答が配る queueDepth を採り、run_start が先の run は
 * 待機中にしない。要求後に新しい状態が届いていれば古いスナップショットは捨てる。
 */
function echoedQueuePosition(
  state: ChatState,
  action: { sendId: string; queuePosition?: number; stateSeq?: number },
  duplicate: Bubble | undefined,
  prompt: string | undefined,
): number | undefined {
  const snapshotCurrent = action.stateSeq === undefined || action.stateSeq === state.stateSeq;
  const carriedPosition = snapshotCurrent ? undefined : state.queuedSnapshots[action.sendId]?.position;
  const echoedPosition = snapshotCurrent ? action.queuePosition : carriedPosition;
  return duplicate?.queuePosition ?? (prompt === undefined ? echoedPosition : undefined);
}

/** 送信キューを受け持つアクション (この関数へ委譲する種別だけを抜き出す) */
type QueueChatAction = Extract<
  ChatAction,
  {
    type:
      | "queued"
      | "queueCleared"
      | "queueCanceled"
      | "localUser"
      | "echoSendId"
      | "resendUnsent"
      | "resendFailed"
      | "unsentDiscarded"
      | "dropLocalUser";
  }
>;

export function applyQueueAction(state: ChatState, action: QueueChatAction): ChatState {
  switch (action.type) {
    case "queued": {
      // 自分の送信の待機を SSE が先に配る経路 (応答より前) でも送信IDで対応付ける
      const bubbles = state.bubbles.map((bubble) =>
        bubble.sendId === action.sendId && bubble.entryId === undefined
          ? {
              ...bubble,
              accepted: true,
              queued: true,
              queuedState: "queued" as const,
              queuePosition: action.position,
            }
          : bubble,
      );
      // 送信IDがまだ結び付いていないエコーには、この送信の待機位置として控えて応答時に引き継ぐ
      const bound = bubbles.some((bubble) => bubble.sendId === action.sendId);
      const queuedSnapshots = bound
        ? withoutQueuedSnapshots(state.queuedSnapshots, [action.sendId])
        : { ...state.queuedSnapshots, [action.sendId]: { position: action.position } };
      return {
        ...state,
        bubbles,
        queuedSnapshots,
        stateSeq: state.stateSeq + 1,
        // 圧縮中は体感の状態を compacting のまま保つ (実際に走っているのは圧縮)
        runStatus: state.runStatus === "compacting" ? "compacting" : "running",
        queueDepth: action.queueDepth,
        // 件数はコンポーザー直上のブロックが正。状態行は活動の語だけを出す
        activity: state.runStatus === "compacting" ? "圧縮中…" : "実行中…",
        activityState: undefined,
      };
    }

    case "queueCleared": {
      /**
       * 破棄された待機メッセージは実行されない。送信IDが分かる分を未送信へ切り替え、「送信済み」の見た目の
       * まま残さない (ID が無いエコーは控えを残し、対応付いた時点で切り替える)。
       */
      const cleared = new Set(action.sendIds);
      const bubbles = state.bubbles.map((bubble) => {
        // 送信IDを持たないバブルは run id で突き合わせる
        const key = bubble.sendId ?? bubble.runId;
        const markUnsent = key !== undefined && cleared.has(key) && bubble.unsent !== true;
        // キューそのものが空になったので、送信IDが分からない分の待機也表示を戻す
        if (!markUnsent && bubble.queued !== true) return bubble;
        return markUnsent ? { ...bubble, ...UNSENT_CLEARED } : { ...bubble, ...QUEUE_CLEARED };
      });
      const pendingEchoIds = state.pendingEchoIds.filter((id) => {
        const bubble = bubbles.find((item) => item.id === id);
        return bubble?.unsent !== true;
      });
      return {
        ...state,
        bubbles,
        pendingEchoIds,
        stateSeq: state.stateSeq + 1,
        queuedSnapshots: withoutQueuedSnapshots(state.queuedSnapshots, action.sendIds),
        // 取りこぼしを防ぐため直近の分だけ持ち、対応が取れたら消す
        clearedSendIds: [...state.clearedSendIds, ...cleared].slice(-20),
        queueDepth: 0,
        activity: "待機キューを取り消しました",
        activityState: undefined,
        // 破棄で待機が消えたので、開始直後の演出も残さない
        startingRunId: undefined,
      };
    }

    case "queueCanceled": {
      // 取り消した送信を未送信へ戻す。resync が成功応答より先に届く経路があるため、既に未送信なら
      // 何もしない (状態行の文言は足さず、バブルが変わることを結果の提示にする)
      const target = state.bubbles.find((bubble) => bubble.sendId === action.sendId);
      if (!target || target.unsent === true) return state;
      return {
        ...state,
        bubbles: state.bubbles.map((bubble) =>
          bubble.sendId === action.sendId ? { ...bubble, ...UNSENT_CLEARED } : bubble,
        ),
        stateSeq: state.stateSeq + 1,
        queuedSnapshots: withoutQueuedSnapshots(state.queuedSnapshots, [action.sendId]),
        // 未送信は pendingEchoIds に残さない (残すと取り消し後の再送で同じ id が二重に載る)
        pendingEchoIds: state.pendingEchoIds.filter((id) => id !== target.id),
      };
    }

    case "localUser": {
      const next = appendBubble(state, "user", action.text, action.at);
      const echoId = next.nextId - 1;
      // 送信時点で既知の最新 item。run_start の吸収判定でこれより後の entry だけを自分の候補にする
      const since = newestHistoryItemId(state.bubbles, state.dividers);
      return {
        ...next,
        bubbles: next.bubbles.map((bubble) => (bubble.id === echoId ? { ...bubble, since } : bubble)),
        // 実行中のターンの本文を積んでいる assistant バブルがあってもそこで受け続ける。ここで落とすと、
        // 次に届く delta がエコーより後ろの新しいバブルを作り、実行に移った送信が応答の途中に見える
        activity: "送信中…",
        activityState: undefined,
        pendingEchoIds: [...state.pendingEchoIds, echoId],
        // 送信の合図。post が失敗して echo を戻しても減らさない (最下部に居続ける方が都合が良い)
        sendSeq: state.sendSeq + 1,
      };
    }

    case "echoSendId": {
      // 送信応答の送信IDを、未対応付けのエコーへ結び付ける (送信は直列なので順序で足りる)。
      // payload が先に送信IDを結び付けたエコーは、そのバブルを対象にする
      const echoId =
        state.bubbles.find(
          (bubble) => bubble.role === "user" && bubble.entryId === undefined && bubble.sendId === action.sendId,
        )?.id ??
        state.pendingEchoIds.find((id) => {
          const bubble = state.bubbles.find((item) => item.id === id);
          return bubble !== undefined && bubble.sendId === undefined;
        });
      if (echoId === undefined) return state;
      // payload が先にバブルを足していたら、ローカルのエコーへ寄せて重複を作らない
      // (同じ送信IDのバブルが 2 件残ると再送 / 破棄が二重に見える)
      const duplicate = state.bubbles.find(
        (bubble) => bubble.id !== echoId && bubble.sendId === action.sendId && bubble.entryId === undefined,
      );
      // run_start が応答より先に届いていれば、控えた本文でローカルエコーを差し替える
      const prompt = action.runId === undefined ? undefined : state.runPrompts[action.runId];
      const queuePosition = echoedQueuePosition(state, action, duplicate, prompt);
      const queued = duplicate !== undefined ? duplicate.queued === true : queuePosition !== undefined;
      const consumedSnapshots = withoutQueuedSnapshots(state.queuedSnapshots, [action.sendId]);
      const withSendId = updateBubble(
        duplicate === undefined
          ? { ...state, queuedSnapshots: consumedSnapshots }
          : {
              ...state,
              bubbles: state.bubbles.filter((b) => b.id !== duplicate.id),
              queuedSnapshots: consumedSnapshots,
            },
        echoId,
        (bubble) => ({
          ...bubble,
          sendId: action.sendId,
          ...(action.runId === undefined ? {} : { runId: action.runId }),
          // 先にあったバブルの状態 (未送信 / 受理済み) を引き継ぐ
          ...(duplicate?.unsent === true ? { unsent: true, accepted: false, confirmed: false } : {}),
          ...(duplicate?.accepted === true
            ? { unsent: false, accepted: true, confirmed: duplicate.confirmed === true }
            : {}),
          ...(queued
            ? {
                queued: true,
                queuedState: duplicate?.queuedState ?? "queued",
                ...(queuePosition === undefined ? {} : { queuePosition }),
              }
            : {}),
          ...(prompt !== undefined ? { text: prompt } : {}),
        }),
      );
      const runPrompts = { ...state.runPrompts };
      if (action.runId !== undefined) delete runPrompts[action.runId];
      // 保存済みの entry が既にあれば、停止の控えより吸収を優先する (権威ある履歴を正とする)
      const target = withSendId.bubbles.find(
        (bubble) =>
          bubble.entryId !== undefined &&
          bubble.role === "user" &&
          (bubble.sendId === action.sendId ||
            // 送信IDを持たない item は run の一致へ縮退する
            (bubble.sendId === undefined && action.runId !== undefined && bubble.runId === action.runId)),
      );
      if (target !== undefined) {
        return {
          ...withSendId,
          runPrompts,
          bubbles: withSendId.bubbles.filter((bubble) => bubble.id !== echoId),
          pendingEchoIds: withSendId.pendingEchoIds.filter((id) => id !== echoId),
          clearedSendIds: state.clearedSendIds.filter((id) => id !== action.sendId),
        };
      }
      // 停止で破棄された送信か、payload が未送信として配った送信なら、通常の送信済みに見せず
      // 未送信へ切り替える (重複して足されたバブルはローカルのエコーへ寄せる)
      if (state.clearedSendIds.includes(action.sendId) || duplicate?.unsent === true) {
        return {
          ...withSendId,
          runPrompts,
          bubbles: withSendId.bubbles.map((bubble) =>
            bubble.id === echoId ? { ...bubble, ...UNSENT_CLEARED } : bubble,
          ),
          pendingEchoIds: withSendId.pendingEchoIds.filter((id) => id !== echoId),
          clearedSendIds: state.clearedSendIds.filter((id) => id !== action.sendId),
        };
      }
      return { ...withSendId, runPrompts };
    }

    case "resendUnsent": {
      // 未送信バブルを pending エコーへ戻す。本文はサーバー側が持つ生テキストを使うため、ここでは
      // 表示だけを通常の送信直後へ切り替える (送信IDは再送でも変わらない)
      const index = state.bubbles.findIndex((bubble) => bubble.unsent === true && bubble.sendId === action.sendId);
      if (index === -1) return state;
      const echo = state.bubbles[index];
      return {
        ...state,
        bubbles: state.bubbles.map((bubble, i) =>
          i === index
            ? { ...bubble, unsent: false, accepted: true, confirmed: false, at: Date.now(), ...CLEARED_TURN_END }
            : bubble,
        ),
        // 再送でも送信と同じく、実行中のターンの本文を受けているバブルに積み続ける
        pendingEchoIds: [...state.pendingEchoIds, echo.id],
        // 停止で破棄された記録を再送するときは、未送信へ戻す控えを消す
        clearedSendIds: state.clearedSendIds.filter((id) => id !== action.sendId),
        activity: "送信中…",
        activityState: undefined,
        // 送信と同じく最下部への追従の合図を進める
        sendSeq: state.sendSeq + 1,
      };
    }

    case "resendFailed": {
      // 再送を受け付けてもらえなかった。通常の送信済みに見せないよう未送信へ戻す。ただし
      // payload / run_start でサーバーの受理を確認済みの run は実行されているので戻さない
      const index = state.bubbles.findIndex((bubble) => bubble.unsent === false && bubble.sendId === action.sendId);
      if (index === -1 || state.bubbles[index].confirmed === true) return state;
      const echo = state.bubbles[index];
      return {
        ...state,
        bubbles: state.bubbles.map((bubble, i) =>
          i === index ? { ...bubble, unsent: true, accepted: false, confirmed: false, ...CLEARED_TURN_END } : bubble,
        ),
        pendingEchoIds: state.pendingEchoIds.filter((id) => id !== echo.id),
      };
    }

    case "unsentDiscarded":
      return {
        ...state,
        bubbles: state.bubbles.filter((bubble) => !(bubble.unsent === true && bubble.sendId === action.sendId)),
      };

    case "dropLocalUser": {
      // post に失敗したエコーを戻す。残すと次の run_start (同じ本文) が失敗分を消費してしまう
      const last = state.pendingEchoIds.at(-1);
      if (last === undefined) return state;
      return {
        ...state,
        bubbles: state.bubbles.filter((bubble) => bubble.id !== last),
        pendingEchoIds: state.pendingEchoIds.slice(0, -1),
      };
    }
  }
}
