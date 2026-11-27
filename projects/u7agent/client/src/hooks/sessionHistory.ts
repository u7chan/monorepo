import type { Dispatch, RefObject } from "react";
import type { ChatHistoryState } from "../lib/chatTypes";
import { apiFailureStatus, messageFor } from "../lib/errors";
import { historyClearedBetween, withoutOldHistory } from "../lib/sessionHistoryClear";
import type { HistoryPage, SessionPayload } from "../types";
import type { ChatAction } from "../lib/chatState";
import { alwaysCurrent, createGenerationTracker } from "./requestGate";

export type SessionHistoryDeps = {
  /** 選択中の会話。await を挟んだ後の判定に使う */
  sessionIdRef: RefObject<string>;
  /** chat 状態の history。追加取得のカーソルは reducer が適用したページの値だけを使う */
  historyStateRef: RefObject<ChatHistoryState>;
  /** 履歴ページの取得。before を省略すると最新ページ */
  requestPage: (sessionId: string, before?: string) => Promise<HistoryPage>;
  dispatch: Dispatch<ChatAction>;
};

/**
 * 履歴ページの取得と、その要求世代・カーソル・クリアの検知。取得中かどうかと直近の payload も
 * ここへ閉じ、`useSessions` には「いつ取り直すか」だけを残す。
 */
export type SessionHistory = {
  /** 最新ページを取り直す。resync (再接続 / 圧縮 / context_edit) のたびに呼び、取得済みの古いページは残す */
  refresh(targetId: string, isCurrent?: () => boolean): Promise<void>;
  /**
   * 上方向の追加取得。カーソルは entry id なので、取得中に追記 / 圧縮されても同じ item を二度返さない。
   * 取得結果は reducer が既存のバブルへ前置きする (古い側は消させない)。
   */
  loadOlder(): Promise<void>;
  /**
   * 欠落区間の取得。resync の最新ページが保持分と繋がらないときに呼ばれ、保留中のページと合わせて
   * 適用する。適用可否は reducer が cursor で判定するため、ここでは seq を進めない。
   */
  fillGap(cursor: string): Promise<void>;
  /** 権威ある payload を適用する前に通す。履歴が入れ替わっていれば捨てて、適用する payload を返す */
  acceptPayload(incoming: SessionPayload): SessionPayload;
  /** 選択の切替 / 引き継ぎの開き直し。取得中の旧ページを適用させない */
  discard(): void;
  /** 会話を持たない状態へ戻す (新規チャット)。前の会話の世代と比較しない */
  forgetChat(): void;
  /** 同じ会話のまま履歴が入れ替わった。旧カーソル・旧バブル・取得中の旧ページを捨てる */
  reset(): void;
  /** 片付け待ちのクリア。開き直さずに手元の履歴だけを捨て、次の payload を新しい世代として扱う */
  resetForCleanup(sessionId: string, generation: string): void;
};

export function createSessionHistory({
  sessionIdRef,
  historyStateRef,
  requestPage,
  dispatch,
}: SessionHistoryDeps): SessionHistory {
  const generation = createGenerationTracker();
  /**
   * 同じ会話で最後に適用した履歴世代。変わったら履歴がクリアされたとみなし、旧カーソル・旧バブル・
   * 取得中の旧ページを捨てて取り直す (会話の切替では比較しない。sessionId も一緒に持つ)。
   */
  let scope: { sessionId: string; generation: string } = { sessionId: "", generation: "" };
  /** 二重取得の防止。破棄した要求の完了でも必ず戻す (適用の可否で分岐すると次を塞ぐ) */
  let loading = false;
  /** 履歴 API が無いときの組み直しに使う直近 payload。セッションを離れるたびに捨てる */
  let latestPayload: SessionPayload | undefined;

  /** 取得中の旧ページを適用させない (会話の切替 / 新規チャット / 引き継ぎ後の開き直し) */
  function discard(): void {
    generation.invalidate();
    loading = false;
    latestPayload = undefined;
  }

  /** 古い応答 (別セッション / 連続 resync / 失効した世代) で新しい表示を戻さない */
  function applies(token: number, targetId: string, isCurrent: () => boolean): boolean {
    return isCurrent() && sessionIdRef.current === targetId && generation.holds(token);
  }

  async function refresh(targetId: string, isCurrent: () => boolean = alwaysCurrent): Promise<void> {
    if (!targetId) return;
    const token = generation.begin();
    try {
      const page = await requestPage(targetId);
      if (!applies(token, targetId, isCurrent)) return;
      dispatch({ type: "resyncHistory", page });
    } catch (error) {
      if (!applies(token, targetId, isCurrent)) return;
      // 履歴 API の 404 (未知ルート / セッション消滅) では payload.messages での表示に戻す
      if (apiFailureStatus(error) === 404) {
        const fallback = latestPayload;
        dispatch({ type: "historyUnsupported", ...(fallback?.sessionId === targetId ? { payload: fallback } : {}) });
      }
    }
  }

  async function loadOlder(): Promise<void> {
    const id = sessionIdRef.current;
    if (!id) return;
    const state = historyStateRef.current;
    const cursor = state.nextCursor;
    if (loading || !state.hasMore || !cursor) return;
    loading = true;
    dispatch({ type: "historyLoading", loading: true });
    try {
      const page = await requestPage(id, cursor);
      // 取得中にセッション / ブランチ / 保持分の先頭が変わっていたら、古いページを混ぜない
      if (sessionIdRef.current !== id || historyStateRef.current.nextCursor !== cursor) return;
      dispatch({ type: "prependHistory", cursor, page });
    } catch (error) {
      if (sessionIdRef.current !== id) return;
      if (apiFailureStatus(error) === 400) {
        // 不明なカーソルは履歴が入れ替わった証拠。最新ページから取り直せば次の操作で遡れる
        void refresh(id);
      } else {
        dispatch({ type: "setActivity", text: `過去の履歴を取得できませんでした。${messageFor(error)}` });
      }
    } finally {
      loading = false;
      dispatch({ type: "historyLoading", loading: false });
    }
  }

  async function fillGap(cursor: string): Promise<void> {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      const page = await requestPage(id, cursor);
      if (sessionIdRef.current !== id) return;
      dispatch({ type: "historyGap", cursor, page });
    } catch (error) {
      if (sessionIdRef.current !== id) return;
      if (apiFailureStatus(error) === 400) {
        // カーソルが現行ブランチに無い (分岐が変わった)。最新ページから取り直す
        void refresh(id);
      } else {
        // 保留を解いて、次の resync で再試行できる状態に戻す
        dispatch({ type: "historyGapFailed", cursor });
        dispatch({ type: "setActivity", text: `履歴の欠落区間を取得できませんでした。${messageFor(error)}` });
      }
    }
  }

  function reset(): void {
    discard();
    dispatch({ type: "resetHistory" });
  }

  return {
    refresh,
    loadOlder,
    fillGap,
    discard,
    reset,
    acceptPayload(incoming: SessionPayload): SessionPayload {
      // 同じ会話で履歴世代が変わった = 履歴のクリア。旧カーソルと進行中の旧要求を失効させ、
      // payload に残る旧メッセージは適用しない (表示はクリア後の履歴を取り直して正とする)
      const cleared = sessionIdRef.current === incoming.sessionId && historyClearedBetween(scope, incoming);
      scope = { sessionId: incoming.sessionId, generation: incoming.historyGeneration };
      if (cleared) reset();
      const payload = cleared ? withoutOldHistory(incoming) : incoming;
      latestPayload = payload;
      return payload;
    },
    forgetChat(): void {
      discard();
      scope = { sessionId: "", generation: "" };
    },
    resetForCleanup(sessionId: string, nextGeneration: string): void {
      reset();
      scope = { sessionId, generation: nextGeneration };
    },
  };
}
