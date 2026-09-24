/**
 * 会話の通知トグルの手順と、新規チャットの先行選択。DOM に依存しない形に切り出し、
 * 「作成の要求時に読んだ値が、応答待ちの間の切替で変わらない」ことをテストで固定する。
 */
import type { SessionNotifyResponse } from "../types";

export interface NotifyToggleDeps {
  /** 新規チャット (セッション未作成) の先行選択を切り替える */
  setPending: () => void;
  /** 一覧の値へ反映する (楽観反映とサーバー値の反映で共通) */
  apply: (sessionId: string, notify: boolean) => void;
  request: (sessionId: string, notify: boolean) => Promise<SessionNotifyResponse>;
  onError: (error: unknown) => void;
}

/**
 * 既存セッションは専用 PATCH で切り替え、新規チャットは作成時に引き継ぐ先行選択を切り替えるだけ。
 * 送るかどうかは finish 時点の値でサーバーが決めるため、ここでは何も送らない。
 */
export async function toggleNotify(sessionId: string, current: boolean, deps: NotifyToggleDeps): Promise<void> {
  if (!sessionId) {
    deps.setPending();
    return;
  }
  const next = !current;
  // 4 秒のポーリングを待たずに反映する (連打でも値が往復する)
  deps.apply(sessionId, next);
  try {
    const result = await deps.request(sessionId, next);
    deps.apply(result.sessionId, result.notify);
  } catch (error) {
    // サーバーは失敗時に値を変えない。楽観反映を戻してから理由を出す
    deps.apply(sessionId, !next);
    deps.onError(error);
  }
}

export type NotifyCarry = {
  /** useSyncExternalStore の購読 */
  subscribe: (listener: () => void) => () => void;
  /** 現在の先行選択。作成の要求へ載せるときは await の前に読む (これが要求時点のスナップショット) */
  snapshot: () => boolean;
  /** 新規チャットのトグル */
  toggle: () => void;
  /** 作成の完了で消費する。切り替え先の会話や次の新規チャットへ持ち越さない */
  consume: () => void;
};

/**
 * 新規チャットの通知の先行選択。セッション未作成の間だけ持ち、最初のメッセージで作られる
 * セッションへ引き継ぐ。作成中に別のチャットへ切り替えても、その選択を切り替え先へ適用しない。
 */
export function createNotifyCarry(): NotifyCarry {
  let value = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => value,
    toggle(): void {
      value = !value;
      emit();
    },
    consume(): void {
      if (!value) return;
      value = false;
      emit();
    },
  };
}
