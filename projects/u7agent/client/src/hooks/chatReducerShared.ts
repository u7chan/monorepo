// 履歴 / 実行 / 送信キュー / ツールの各群が共有する、状態の書き換えと結末・再試行・区切りの規則。
import { compactionDividerIndex } from "../lib/compaction";
import type { Bubble, CompactionMarker } from "../lib/chatTypes";
import type { CompactionInfo, RunOutcome, RunRetryState } from "../types";
import type { ChatState } from "../lib/chatState";

/** retryAt と serverNow の差を残り時間として控える。どちらか欠けたら undefined (推測で時刻を合成しない) */
function retrySnapshot(
  retry: RunRetryState | null | undefined,
  serverNow: number | undefined,
  receivedAt: number,
): Pick<ChatState, "retry" | "retryRemainingMs" | "retryReceivedAt"> {
  if (!retry) return { retry: undefined, retryRemainingMs: undefined, retryReceivedAt: undefined };
  const remaining =
    retry.retryAt === undefined || serverNow === undefined ? undefined : Math.max(0, retry.retryAt - serverNow);
  // 残りが無いとき (retrying / 復元不能) は tick の起点も持たない
  return { retry, retryRemainingMs: remaining, retryReceivedAt: remaining === undefined ? undefined : receivedAt };
}

/**
 * 同じ待機 (同じ attempt / retryAt) を再度受けたときは、既に得た期限を後ろへずらさない。
 * SSE のリプレイで古い `run_retry` / `resync` が届いても、受信時刻の更新で待機を延長しないための保険。
 */
export function mergeRetrySnapshot(
  state: ChatState,
  retry: RunRetryState | null | undefined,
  serverNow: number | undefined,
  receivedAt: number,
): Pick<ChatState, "retry" | "retryRemainingMs" | "retryReceivedAt"> {
  const next = retrySnapshot(retry, serverNow, receivedAt);
  const sameWaiting =
    next.retry?.phase === "waiting" &&
    state.retry?.phase === "waiting" &&
    state.retry.attempt === next.retry.attempt &&
    state.retry.retryAt !== undefined &&
    state.retry.retryAt === next.retry.retryAt;
  const keptRemaining = state.retryRemainingMs;
  const keptReceivedAt = state.retryReceivedAt;
  const nextDeadline = next.retryRemainingMs === undefined ? undefined : receivedAt + next.retryRemainingMs;
  const keptDeadline =
    keptRemaining === undefined || keptReceivedAt === undefined ? undefined : keptReceivedAt + keptRemaining;
  if (sameWaiting && nextDeadline !== undefined && keptDeadline !== undefined && nextDeadline > keptDeadline) {
    return { retry: next.retry, retryRemainingMs: keptRemaining, retryReceivedAt: keptReceivedAt };
  }
  return next;
}

/** 旧 payload の compactions から区切りを復元する (位置を持つのは最新の 1 件だけ) */
export function legacyMarkers(compactions: CompactionInfo[]): CompactionMarker[] {
  const index = compactionDividerIndex(compactions);
  const latest = compactions[compactions.length - 1];
  if (index === undefined || !latest) return [];
  return [{ id: latest.id, index, compactions }];
}

/**
 * 履歴ページから取り込んだ item を表示に持つか (entryId はページ由来のバブルにだけ付く)。
 * ページ取得が一時的に失敗しても payload.messages (圧縮後は有効コンテキストだけ) へ
 * 表示を戻さないための判定に使う。
 */
export function holdsFetchedHistory(state: ChatState): boolean {
  return state.bubbles.some((bubble) => bubble.entryId !== undefined);
}

export function normalizeInitialSend(bubbles: Bubble[], initialSendId: string | undefined): Bubble[] {
  if (initialSendId === undefined) return bubbles;
  return bubbles.map((bubble) =>
    bubble.role === "user" && bubble.sendId === initialSendId && bubble.unsent !== true
      ? {
          ...bubble,
          queued: undefined,
          queuedState: undefined,
          queuePosition: undefined,
          unsent: false,
          accepted: true,
        }
      : bubble,
  );
}

/** ツールカードの持ち主の索引。同じ call は最初に持つバブルだけを指す */
export function toolBubbleIdsOf(bubbles: Bubble[]): Record<string, number> {
  const ids: Record<string, number> = {};
  for (const bubble of bubbles) {
    for (const card of bubble.tools) {
      if (ids[card.id] === undefined) ids[card.id] = bubble.id;
    }
  }
  return ids;
}

/** 送信エコーの照合用の正規形。添付の注記を落とし、`/skill:` の展開結果は打ったコマンドの形へ戻す。
 * ローカルエコー (素の入力) と run_start (展開済みの本文) を同じ形に寄せるために使う。 */
export function appendBubble(state: ChatState, role: Bubble["role"], text = "", at?: number): ChatState {
  const bubble: Bubble = { id: state.nextId, role, text, tools: [], skillLoads: [], at };
  return {
    ...state,
    bubbles: [...state.bubbles, bubble],
    nextId: state.nextId + 1,
  };
}

export function updateBubble(state: ChatState, id: number, update: (bubble: Bubble) => Bubble): ChatState {
  return { ...state, bubbles: state.bubbles.map((b) => (b.id === id ? update(b) : b)) };
}

/** 送信IDが確定した / より新しい状態が届いた送信の待機位置を落とす */
export function withoutQueuedSnapshots(
  snapshots: ChatState["queuedSnapshots"],
  sendIds: readonly string[],
): ChatState["queuedSnapshots"] {
  let next = snapshots;
  for (const sendId of sendIds) {
    if (next[sendId] === undefined) continue;
    if (next === snapshots) next = { ...snapshots };
    delete next[sendId];
  }
  return next;
}

/**
 * 未送信へ戻す / 再送する分岐で、前のランの値を消す。表示導出は unsent を見て行を落とすが、値自体を
 * 持ち越すと再送後に古い所要時間が残る
 */
export const CLEARED_TURN_END = { runDurationMs: undefined, runOutcome: undefined } as const;

/** 待機を抜けたバブルへ古い順位を残さない (表示の導出は queued だけを見る) */
export const QUEUE_CLEARED = { queued: undefined, queuedState: undefined, queuePosition: undefined } as const;

/**
 * 破棄された送信の表示。待機の印と実行の結末を落として未送信へ戻す (片方だけ落とすと、待機の順位が
 * 残ったまま再送の対象になる)
 */
export const UNSENT_CLEARED = {
  unsent: true,
  accepted: false,
  confirmed: false,
  ...CLEARED_TURN_END,
  ...QUEUE_CLEARED,
} as const;

/** run が終わったことを、その実行を開始した送信のバブルへだけ写す (追加入力へ複製しない) */
export function attachTurnEnd(
  bubbles: Bubble[],
  runId: string,
  initialSendId: string | undefined,
  outcome: RunOutcome,
  durationMs: number,
): Bubble[] {
  const target = (bubble: Bubble): boolean =>
    bubble.role === "user" && (initialSendId !== undefined ? bubble.sendId === initialSendId : bubble.runId === runId);
  return bubbles.map((bubble) =>
    target(bubble) ? { ...bubble, runDurationMs: durationMs, runOutcome: outcome } : bubble,
  );
}

export function attachAssistantTurnEnd(
  bubbles: Bubble[],
  runId: string | undefined,
  initialSendId: string | undefined,
  outcome: RunOutcome,
  durationMs: number,
  currentAssistantId: number | null,
): Bubble[] {
  if (runId === undefined) return bubbles;
  const prefix = `${runId}:`;
  const initialIndex =
    initialSendId === undefined
      ? -1
      : bubbles.findIndex((bubble) => bubble.role === "user" && bubble.sendId === initialSendId);
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    const bubble = bubbles[index];
    if (bubble.role !== "assistant" || bubble.text === "") continue;
    if (bubble.assistantId !== undefined) {
      if (!bubble.assistantId.startsWith(prefix)) continue;
    } else if (bubble.id !== currentAssistantId && (initialIndex === -1 || index <= initialIndex)) {
      // ID の無い旧データで開始 user より前の応答へ結末を付けない
      continue;
    }
    // この実行の最後の本文応答がここ。既に結末があるなら前の応答へ遡らない (再同期のたびに
    // Done が増えると、実行単位で最後の本文応答に 1 回だけ、という契約が崩れる)
    if (bubble.turnEnd !== undefined) return bubbles;
    return bubbles.map((item, position) => (position === index ? { ...item, turnEnd: { outcome, durationMs } } : item));
  }
  return bubbles;
}
