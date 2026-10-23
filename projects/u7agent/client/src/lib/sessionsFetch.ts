/**
 * 一覧取得の状態と要求の採否。React 非依存の制御 module として `useSessions` が 1 つだけ所有し、
 * 初回未取得 / 取得中 / 成功 / 失敗と最終成功時刻を区別する。前回の一覧は `useSessions` が保持し、
 * ここは「どの応答を採用するか」と「取得中か」だけを持つ (0 件の成功と未取得を混同しないため)。
 *
 * - **進行中の要求があれば共有する。** 4 秒ポーリング / SSE の再取得 / 画面を開いたときの取り直し /
 *   再読み込みが重なっても GET を積み上げない (遅い応答でも初回成功が追い越されて捨てられない)
 * - `pending` は飛んでいる要求が 1 つでもあれば真。破棄された要求の完了でも必ず解除する
 * - `invalidate` は進行中の要求をまとめて失効させる (スペース切替 / unmount 後の応答を適用しない)
 */
export type SessionsFetchSnapshot = {
  /** 初回の取得に成功したか。一度でも成功したら真のまま (`sessionsLoaded` の既存契約) */
  loaded: boolean;
  /** 一覧の取得中。自動・手動を問わず 1 つでも飛んでいれば真 (再読み込みの無効化に使う) */
  pending: boolean;
  /** 直近の取得が失敗した。前回の一覧は保たれている (未取得なら loaded が偽のまま) */
  failed: boolean;
  /** 最後に成功した時刻 (epoch ms)。日付を含む整形は表示側が行う */
  lastSuccessAt?: number;
};

export type SessionsFetchLoader<T> = {
  /** 実際の GET。呼ばれるのは、飛んでいる要求が無いときだけ */
  fetch: () => Promise<T>;
  /** 応答の適用。共有した要求でも 1 回だけ呼ばれる */
  apply: (data: T) => void;
};

export type SessionsFetchLoadOptions = {
  /**
   * 進行中の要求を追い越して新しい GET を出す。作成 / 削除 / 移動 / 送信の直後のように、
   * 変更前の一覧を返した要求に相乗りしてはいけない場面で使う。
   */
  supersede?: boolean;
};

export type SessionsFetch<T> = {
  snapshot(): SessionsFetchSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * 一覧を取り直す。進行中の要求があれば同じ Promise を返し、新しい GET は出さない
   * (`supersede` のときは失効させてから新しい GET を出す)。
   * 成否は戻り値で返す (失敗・失効は null)。適用は `apply` が 1 回だけ行う。
   */
  load(loader: SessionsFetchLoader<T>, options?: SessionsFetchLoadOptions): Promise<T | null>;
  /** 進行中の要求を失効させる (以後の応答は適用しない) */
  invalidate(): void;
};

export function createSessionsFetch<T>(): SessionsFetch<T> {
  /** 世代。invalidate で進み、古い要求の応答を適用しない */
  let generation = 0;
  /** 飛んでいる要求 (失効したものも含む) の数。合流した呼び出しは数えない */
  let inflight = 0;
  /** 共有する進行中の要求。世代が古いものは合流に使わない */
  let active: { id: number; generation: number; promise: Promise<T | null> } | null = null;
  let nextRequestId = 0;
  let current: SessionsFetchSnapshot = { loaded: false, pending: false, failed: false };
  const listeners = new Set<() => void>();

  const publish = (next: SessionsFetchSnapshot): void => {
    if (
      next.loaded === current.loaded &&
      next.pending === current.pending &&
      next.failed === current.failed &&
      next.lastSuccessAt === current.lastSuccessAt
    )
      return;
    current = next;
    for (const listener of listeners) listener();
  };

  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load({ fetch, apply }, options = {}) {
      if (options.supersede) {
        // 変更前の一覧を返した要求に相乗りしないよう、失効させてから新しい GET を出す
        generation += 1;
      } else if (active && active.generation === generation) {
        // 進行中の要求があれば相乗りする (同じ世代の要求だけ。失効後は新しい GET を出す)
        return active.promise;
      }
      const requestId = ++nextRequestId;
      const requestGeneration = generation;
      inflight += 1;
      publish({ ...current, pending: true });
      // 同期例外で finally が先に走った場合に、決着済みの Promise を共有しないための印
      let settled = false;
      const promise = (async (): Promise<T | null> => {
        let data: T | null = null;
        let applied = false;
        try {
          data = await fetch();
          // 失効した要求は適用も状態変更もしない (新しい要求の結果を巻き戻さない)
          if (requestGeneration === generation) {
            apply(data);
            applied = true;
          }
        } catch {
          // 失敗は finally で記録する (成否の判定を 1 箇所に寄せる)
        } finally {
          settled = true;
          inflight -= 1;
          if (active?.id === requestId) active = null;
          if (applied) {
            publish({ loaded: true, pending: inflight > 0, failed: false, lastSuccessAt: Date.now() });
          } else if (requestGeneration === generation) {
            publish({ ...current, pending: inflight > 0, failed: true });
          } else {
            // 失効した要求の完了は取得中の解除だけを行う
            publish({ ...current, pending: inflight > 0 });
          }
        }
        return applied ? data : null;
      })();
      if (!settled) active = { id: requestId, generation: requestGeneration, promise };
      return promise;
    },
    invalidate() {
      generation += 1;
    },
  };
}
