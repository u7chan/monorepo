/**
 * 一覧取得の状態と要求の採否。React 非依存の制御 module として `useSessions` が 1 つだけ所有し、
 * 初回未取得 / 取得中 / 成功 / 失敗と最終成功時刻を区別する。前回の一覧は `useSessions` が保持し、
 * ここは「どの応答を採用するか」と「取得中か」だけを持つ (0 件の成功と未取得を混同しないため)。
 *
 * - 応答は後から始めた要求のものだけを採用する (逆順に完了した古い要求で表示を巻き戻さない)
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

export type SessionsFetchOutcome = "applied" | "failed" | "discarded";

export type SessionsFetchTicket = {
  /** この応答を一覧へ適用してよいか (失効・後続の要求があるときは偽) */
  accepts(): boolean;
  /**
   * 要求の完了。`applied` は一覧へ適用したときだけ渡す。取得中はどの経路でも解除し、
   * `loaded` / `failed` / `lastSuccessAt` は最新の要求だけが変える。
   */
  finish(outcome: SessionsFetchOutcome, at?: number): void;
};

export type SessionsFetch = {
  snapshot(): SessionsFetchSnapshot;
  subscribe(listener: () => void): () => void;
  begin(): SessionsFetchTicket;
  /** 進行中の要求を失効させる (以後の応答は `accepts()` が偽になる) */
  invalidate(): void;
};

export function createSessionsFetch(): SessionsFetch {
  let latest = 0;
  const inflight = new Set<number>();
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
    begin() {
      const request = ++latest;
      inflight.add(request);
      publish({ ...current, pending: true });
      let finished = false;
      return {
        accepts: () => request === latest,
        finish(outcome, at) {
          // 二重完了で取得中を誤って解除しない (finally と catch の両方から呼ばれても 1 回)
          if (finished) return;
          finished = true;
          inflight.delete(request);
          const pending = inflight.size > 0;
          if (outcome === "applied" && request === latest) {
            publish({ loaded: true, pending, failed: false, lastSuccessAt: at ?? Date.now() });
            return;
          }
          if (outcome === "failed" && request === latest) {
            publish({ ...current, pending, failed: true });
            return;
          }
          publish({ ...current, pending });
        },
      };
    },
    invalidate() {
      // 世代を進めるだけにする (飛んでいる要求の完了で pending を解除できる状態は保つ)
      latest += 1;
    },
  };
}
