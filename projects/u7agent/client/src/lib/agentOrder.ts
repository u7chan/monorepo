/**
 * 設定 → エージェント（/settings/agents）の並べ替えの保存と反映。ドラッグの下書きはページが持ち、
 * 確定時の手順（保存 → 即時反映 → 取り直し）と、失敗の分類だけをここへ閉じる。
 * DOM も React も知らないので、呼び出し側（AgentSettingsPage）が状態を受け取って描画に使う。
 */
import { ApiError } from "../api";

export type AgentOrderState = {
  /** ドラッグ中の下書き順（ユーザー定義の id）。null = カタログの順（確定済み） */
  draft: string[] | null;
  /** 送信を直列化する。保存中は次のドラッグを始めさせない */
  saving: boolean;
};

/** 通知の種類。文言はページが持ち、ここは分類だけを渡す */
export type AgentOrderNoteKind =
  /** HTTP エラーの応答。保存されていないので元の順へ戻す */
  | "rejected"
  /** 応答が返らない失敗（接続断 / タイムアウト）。保存結果が不明なので表示は戻さない */
  | "unknown"
  /** 保存はできたが、一覧を取り直せない */
  | "refresh";

export type AgentOrderFlowOptions = {
  /** 現在のユーザー定義の id 順（確定済みのカタログから読む） */
  ids: () => string[];
  /** 並びを保存し、サーバーが採用した順を返す（PATCH /api/agents/order） */
  save: (ids: string[]) => Promise<string[]>;
  /** 確定した順を共有カタログへ即時に反映する（同時に取得の世代を進める） */
  apply: (ids: string[]) => void;
  /** 確定後にカタログを取り直す */
  refresh: () => Promise<unknown>;
  note: (kind: AgentOrderNoteKind, message: string) => void;
  /** 下書きと保存中の状態をページへ渡す */
  onChange: (state: AgentOrderState) => void;
};

export type AgentOrderFlow = {
  state(): AgentOrderState;
  /** ドラッグ中の live 差し替え。保存中は受け付けない */
  preview(ids: readonly string[]): void;
  /** ドラッグの取り消し。下書きを捨ててカタログの順へ戻す */
  cancel(): void;
  /** 確定。ドラッグしていなければ何もしない */
  commit(): Promise<void>;
  /**
   * サーバーの正を取り込んだ（カタログの更新）。**結果不明のまま残している下書きだけ**を捨てて
   * 表示をサーバーの並びへ戻す（`AgentSettingsPage` がカタログの更新で呼ぶ）。
   */
  settle(): void;
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAgentOrderFlow(options: AgentOrderFlowOptions): AgentOrderFlow {
  let state: AgentOrderState = { draft: null, saving: false };
  /** 応答が返らず結果不明のまま残している下書き。次の取得（settle）までだけ表示に残す */
  let unconfirmed = false;
  const publish = () => options.onChange({ draft: state.draft ? [...state.draft] : null, saving: state.saving });

  return {
    state: () => ({ draft: state.draft ? [...state.draft] : null, saving: state.saving }),

    preview(ids) {
      if (state.saving) return;
      unconfirmed = false;
      state = { draft: [...ids], saving: state.saving };
      publish();
    },

    cancel() {
      if (!state.draft) return;
      unconfirmed = false;
      state = { draft: null, saving: state.saving };
      publish();
    },

    settle() {
      if (!unconfirmed) return;
      unconfirmed = false;
      state = { draft: null, saving: state.saving };
      publish();
    },

    async commit() {
      // 保存中のドラッグは開始させない前提。ここでも直列化して、到達順の逆転で古い操作が最終値にならないようにする
      if (state.saving) return;
      // 動かしていないドラッグ（レきい値を越えて戻した / 同位置へ落とした）では送らない
      const ids = state.draft;
      const current = options.ids();
      if (!ids || (ids.length === current.length && ids.every((id, index) => id === current[index]))) return;
      state = { draft: [...ids], saving: true };
      publish();

      let saved: string[];
      try {
        saved = await options.save([...ids]);
      } catch (error) {
        if (error instanceof ApiError) {
          // HTTP エラーの応答は保存されていないため、元の順へ戻して理由を出す
          unconfirmed = false;
          state = { draft: null, saving: false };
          publish();
          options.note("rejected", messageFor(error));
        } else {
          // 応答が返らない失敗は保存結果が不明。表示は戻さず、**次の取得（settle）**でサーバーの正に合わせる
          unconfirmed = true;
          state = { draft: [...ids], saving: false };
          publish();
          options.note("unknown", messageFor(error));
        }
        return;
      }

      // 確定した順は、取り直しの応答を待たずに共有カタログへ反映する
      unconfirmed = false;
      options.apply(saved);
      state = { draft: null, saving: false };
      publish();
      try {
        await options.refresh();
      } catch (error) {
        // ローカルには確定順が残っているので、並びは戻さず「取り直せない」だけを伝える
        options.note("refresh", messageFor(error));
      }
    },
  };
}
