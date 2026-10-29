/**
 * コピー結果の表示を持つ controller。`useMessageCopy` はこの controller を 1 つ持ち、
 * React の state へは `onChange` で写すだけにする (結果の適用可否とタイマーはここが正)。
 */

export type CopyFailure = { id: string; detail: string };

export type CopyResultSnapshot = { copiedId: string; failure: CopyFailure | null };

/** タイマーの差し替え口。テストでは発火を手動で進める */
export type CopyResultTimers = {
  set(handler: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const DEFAULT_TIMERS: CopyResultTimers = {
  set: (handler, ms) => setTimeout(handler, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type CopyResultControllerOptions = {
  /** クリップボードへの書き込み。本番は `client/src/lib/copyToClipboard.ts` */
  copy: (text: string) => Promise<void>;
  /** 表示が変わったときの通知 (React の setState を渡す) */
  onChange: (snapshot: CopyResultSnapshot) => void;
  /** 成功の表示を残す時間 */
  resetMs?: number;
  /** 失敗の表示を残す時間 (成功より長い) */
  failureResetMs?: number;
  timers?: CopyResultTimers;
  /** 失敗の記録。開発者ツールを開けない環境でも原因を残す */
  reportError?: (error: unknown) => void;
};

export type CopyResultController = {
  snapshot(): CopyResultSnapshot;
  /**
   * 表示の所有者 (会話 ID など) を切り替える。変わったら未完了のコピーを失効させ、表示も消す。
   * 所有者が同じ間は何もしない (毎描画で呼んでよい)
   */
  setOwner(owner: string): void;
  /**
   * 表示を変えずに、未完了のコピーとタイマーを捨てる (所有部品の unmount)。以後に届いた結果は適用しない。
   * 破棄フラグは持たず世代だけを進めるので、StrictMode の effect 再実行 (mount → cleanup → mount) でも
   * その後のコピーは普通に動く
   */
  invalidate(): void;
  /** コピーを始める。完了時、開始より後に所有者が変わった / 無効化された場合は結果を適用しない */
  copy(text: string, id: string): Promise<void>;
};

export function createCopyResultController({
  copy,
  onChange,
  resetMs = 2000,
  failureResetMs = 8000,
  timers = DEFAULT_TIMERS,
  reportError = (error) => console.error("クリップボードへのコピーに失敗しました", error),
}: CopyResultControllerOptions): CopyResultController {
  let owner: string | null = null;
  let snapshot: CopyResultSnapshot = { copiedId: "", failure: null };
  // 開始のたびに進む世代。失効 (所有者の切替 / unmount) でも進め、古い Promise の結果を捨てる
  let generation = 0;
  let successTimer: unknown = null;
  let failureTimer: unknown = null;

  const publish = (next: CopyResultSnapshot) => {
    if (next.copiedId === snapshot.copiedId && next.failure === snapshot.failure) return;
    snapshot = next;
    onChange(snapshot);
  };

  const clearTimers = () => {
    if (successTimer !== null) timers.clear(successTimer);
    if (failureTimer !== null) timers.clear(failureTimer);
    successTimer = null;
    failureTimer = null;
  };

  const invalidate = () => {
    generation += 1;
    clearTimers();
  };

  // 新しい結果を出す前に必ず古いタイマーを解除する。ハンドルを上書きすると、旧タイマーが
  // 新しい表示 (別のコピーの成功 / 失敗) を先に消してしまう
  const scheduleSuccessReset = () => {
    clearTimers();
    successTimer = timers.set(() => {
      successTimer = null;
      publish({ ...snapshot, copiedId: "" });
    }, resetMs);
  };

  const scheduleFailureReset = () => {
    clearTimers();
    failureTimer = timers.set(() => {
      failureTimer = null;
      publish({ ...snapshot, failure: null });
    }, failureResetMs);
  };

  return {
    snapshot: () => snapshot,
    setOwner(next) {
      if (owner === next) return;
      owner = next;
      invalidate();
      publish({ copiedId: "", failure: null });
    },
    invalidate,
    async copy(text, id) {
      const token = ++generation;
      const holds = () => token === generation;
      // 直前の失敗だけを消す (前の成功のチェックは新しい結果が届くまで残す)
      publish({ copiedId: snapshot.copiedId, failure: null });
      try {
        await copy(text);
      } catch (error) {
        if (!holds()) return;
        reportError(error);
        // 失敗時は成功表示にしない (以前のクリップボード内容を成功と誤認させるため)
        publish({ copiedId: "", failure: { id, detail: error instanceof Error ? error.message : String(error) } });
        scheduleFailureReset();
        return;
      }
      // 待機中に所有者が変わった / 別のコピーが始まったら、古い結果は表示しない
      if (!holds()) return;
      publish({ copiedId: id, failure: null });
      scheduleSuccessReset();
    },
  };
}
