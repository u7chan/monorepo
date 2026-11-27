/**
 * 設定の一覧の並べ替えの下書きと、送信の直列化。ドラッグの live 差し替え・取り消し・確定の前半だけを
 * ここへ閉じる (反映と取り直し、結果不明の失敗は一覧ごとに契約が違うので `reorderFlow` が持つ)。
 */
export type OrderDraftState = {
  /** ドラッグ中の下書き順（並べ替え対象の id）。null = サーバーの確定順 */
  draft: string[] | null;
  /** 送信を直列化する。保存中は次のドラッグを始めさせない */
  saving: boolean;
};

export type OrderDraftOptions = {
  /** 現在の確定順（並べ替え対象の id だけ） */
  ids: () => readonly string[];
  /** 下書きと保存中の状態をページへ渡す */
  onChange: (state: OrderDraftState) => void;
};

export type OrderDraft = {
  state(): OrderDraftState;
  /** ドラッグ中の live 差し替え。保存中は受け付けず、false を返す（下書きも変えない） */
  preview(ids: readonly string[]): boolean;
  /** ドラッグの取り消し。下書きを捨てて確定順へ戻す。下書きが無ければ false を返す */
  cancel(): boolean;
  /**
   * 確定を始める。送らないとき（保存中 / ドラッグしていない / 同じ順へ落とした）は undefined を返し、
   * 送るときは saving を立てて、保存する id を返す。
   */
  begin(): string[] | undefined;
  /** 下書きだけを捨てる。保存中の印は変えない（確定の応答を待たずに捨てる経路がある） */
  discard(): void;
  /** 保存の結果を反映する。null は確定、配列は結果不明のまま残す（保存中の印は落とす） */
  finish(draft: readonly string[] | null): void;
};

/** 下書きを複製して返す。呼び出し側が配列を書き換えても、こちらの状態は変えない */
function copy(draft: readonly string[] | null): string[] | null {
  return draft ? [...draft] : null;
}

export function createOrderDraft(options: OrderDraftOptions): OrderDraft {
  let state: OrderDraftState = { draft: null, saving: false };
  const publish = () => options.onChange({ draft: copy(state.draft), saving: state.saving });

  return {
    state: () => ({ draft: copy(state.draft), saving: state.saving }),

    preview(ids) {
      if (state.saving) return false;
      state = { draft: [...ids], saving: state.saving };
      publish();
      return true;
    },

    cancel() {
      if (!state.draft) return false;
      state = { draft: null, saving: state.saving };
      publish();
      return true;
    },

    begin() {
      // 保存中のドラッグは開始させない前提。ここでも直列化して、到達順の逆転で古い操作が最終値にならないようにする
      if (state.saving) return undefined;
      // 動かしていないドラッグ（しきい値を越えて戻した / 同位置へ落とした）では送らない
      const ids = state.draft;
      const current = options.ids();
      if (!ids || (ids.length === current.length && ids.every((id, index) => id === current[index]))) {
        return undefined;
      }
      state = { draft: [...ids], saving: true };
      publish();
      return [...ids];
    },

    discard() {
      if (!state.draft) return;
      state = { draft: null, saving: state.saving };
      publish();
    },

    finish(draft) {
      state = { draft: copy(draft), saving: false };
      publish();
    },
  };
}
