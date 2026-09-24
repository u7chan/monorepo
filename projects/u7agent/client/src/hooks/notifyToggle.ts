/**
 * 会話の通知トグルの手順と、新規チャットの先行選択。DOM に依存しない形に切り出し、
 * 「作成の要求時に読んだ値が、応答待ちの間の切替で変わらない」ことと「後発のクリックが最終値になる」ことを
 * テストで固定する。
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

export type NotifyToggleRunner = {
  /** 会話の通知トグル。セッション未作成なら作成時に引き継ぐ先行選択だけを切り替える */
  toggle: (sessionId: string, current: boolean) => void;
};

/**
 * 通知トグルの実行。同じ会話の PATCH は直列化し (後発のクリックがサーバーの最終値になる)、
 * 応答の反映と失敗時のロールバックは最新の要求のものだけにする (古い応答で表示を巻き戻さない)。
 * 送るかどうかは finish 時点の値でサーバーが決めるため、ここでは値の切り替えだけを送る。
 */
export function createNotifyToggleRunner(deps: NotifyToggleDeps): NotifyToggleRunner {
  /** 会話ごとの実行待ち。前の要求が終わってから次を送る */
  const chains = new Map<string, Promise<void>>();
  /** 会話ごとの最後の要求。応答を反映してよいかの判定に使う */
  const latest = new Map<string, number>();
  let seq = 0;

  const run = async (sessionId: string, next: boolean, token: number): Promise<void> => {
    try {
      const result = await deps.request(sessionId, next);
      // 後発のクリックがあるので、この応答で表示を巻き戻さない
      if (latest.get(sessionId) !== token) return;
      deps.apply(result.sessionId, result.notify);
    } catch (error) {
      if (latest.get(sessionId) !== token) return;
      // サーバーは失敗時に値を変えない。楽観反映を戻して理由を出す
      // (戻し先は要求前の値で、サーバーの現在値とずれても 4 秒のポーリングが揃える)
      deps.apply(sessionId, !next);
      deps.onError(error);
    }
  };

  return {
    toggle(sessionId: string, current: boolean): void {
      if (!sessionId) {
        deps.setPending();
        return;
      }
      const token = (seq += 1);
      latest.set(sessionId, token);
      const next = !current;
      // 4 秒のポーリングを待たずに反映する (連打でも値が往復する)
      deps.apply(sessionId, next);
      const previous = chains.get(sessionId) ?? Promise.resolve();
      const chained = previous.then(() => run(sessionId, next, token));
      chains.set(sessionId, chained);
      void chained.finally(() => {
        // 待ち行列を残さない (次の切替は新しい鎖から始める)
        if (chains.get(sessionId) === chained) chains.delete(sessionId);
      });
    },
  };
}

/** 作成の要求へ載せる先行選択と、その時点の世代 */
export type NotifyCarryRequest = { value: boolean; generation: number };

export type NotifyCarry = {
  /** useSyncExternalStore の購読 */
  subscribe: (listener: () => void) => () => void;
  /** 現在の先行選択 (画面の表示用) */
  snapshot: () => boolean;
  /** 新規チャットのトグル */
  toggle: () => void;
  /** 作成の要求へ載せる値を読む。応答の適用時に consume へ世代を渡す */
  beginCreate: () => NotifyCarryRequest;
  /** 作成の完了で消費する。世代が変わっていたら (切替 / 押し直しの後) 今の選択を消さない */
  consume: (generation: number) => void;
  /** チャットの切替で先行選択を捨てる。進行中の作成があっても、その応答で消させない */
  reset: () => void;
};

/**
 * 新規チャットの通知の先行選択。セッション未作成の間だけ持ち、最初のメッセージで作られる
 * セッションへ引き継ぐ。値が変わるたびに世代を進めるので、古い作成の応答が
 * 「いま選び直した値」を消費しない (切替先の会話や次の新規チャットへ持ち越さない)。
 */
export function createNotifyCarry(): NotifyCarry {
  let value = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const clear = () => {
    if (!value) return;
    value = false;
    emit();
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
      generation += 1;
      emit();
    },
    beginCreate: () => ({ value, generation }),
    consume(consumed: number): void {
      if (generation !== consumed) return;
      clear();
    },
    reset(): void {
      generation += 1;
      clear();
    },
  };
}
