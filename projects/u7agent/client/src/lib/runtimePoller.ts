/**
 * サービス状態のポーリングの骨格。適用してよいかの判定 (世代)、操作中の取得の抑止、画面を閉じた後の
 * 破棄を 1 か所に持つ。操作を始めた時点で世代を進めるので、以前の遅い応答は結果を上書きしない。
 */
export interface RuntimePolledState<TStatus> {
  status: TStatus | null;
  loading: boolean;
  failed: boolean;
}

export interface RuntimePoller<TStatus, TState extends RuntimePolledState<TStatus>> {
  /** いまの state。保持せず、操作のたびにその場で読む */
  state: () => TState;
  /** 取得。操作中と取得中は発行しない */
  refresh: () => Promise<void>;
  /** 操作の開始。世代を進め、進行中の取得の結果を捨てる */
  begin: (patch: Partial<TState>) => void;
  /** 操作の途中経過と結果を state へ反映する（破棄後は通知しない） */
  update: (patch: Partial<TState>) => void;
  isActive: () => boolean;
  dispose: () => void;
}

export function createRuntimePoller<TStatus, TState extends RuntimePolledState<TStatus>>(deps: {
  initial: TState;
  /** 取得を発行しない間（操作の確認待ちと実行中）だけ true */
  isBusy: (state: TState) => boolean;
  fetchStatus: () => Promise<TStatus>;
  onChange: (state: TState) => void;
}): RuntimePoller<TStatus, TState> {
  let state = deps.initial;
  let active = true;
  let inFlight = false;
  let revision = 0;
  const publish = (next: TState): void => {
    if (!active) return;
    state = next;
    deps.onChange(state);
  };
  const update = (patch: Partial<TState>): void => publish({ ...state, ...patch });
  // 取得の結果は loading と failed まで置き換える（部分更新の型だと、呼び出し側から status を渡せない）
  const applyFetched = (next: RuntimePolledState<TStatus>): void => publish({ ...state, ...next });

  const refresh = async (): Promise<void> => {
    if (!active || inFlight || deps.isBusy(state)) return;
    inFlight = true;
    const issued = revision;
    try {
      const status = await deps.fetchStatus();
      if (issued !== revision) return;
      applyFetched({ status, loading: false, failed: false });
    } catch {
      if (issued !== revision) return;
      applyFetched({ status: null, loading: false, failed: true });
    } finally {
      inFlight = false;
    }
  };

  return {
    state: () => state,
    refresh,
    begin: (patch) => {
      revision += 1;
      update(patch);
    },
    update,
    isActive: () => active,
    dispose: () => {
      active = false;
      revision += 1;
    },
  };
}
