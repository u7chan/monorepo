/**
 * 設定の一覧の並べ替えの保存と反映。確定時の手順 (保存 → 即時反映 → 取り直し) と失敗の分類だけを
 * ここへ閉じる (下書きと直列化は `lib/orderDraft.ts`)。DOM も React も知らない。
 */
import { ApiError } from "../api/http";
import { messageFor } from "./errors";
import { createOrderDraft, type OrderDraftState } from "./orderDraft";

export type ReorderState = OrderDraftState;

/** 通知の種類。文言はページが持ち、ここは分類だけを渡す */
export type ReorderNoteKind =
  /** HTTP エラーの応答。保存されていないので元の順へ戻す */
  | "rejected"
  /** 応答が返らない失敗（接続断 / タイムアウト）。保存結果が不明なので表示は戻さない */
  | "unknown"
  /** 保存はできたが、一覧を取り直せない */
  | "refresh";

export type ReorderFlowOptions = {
  /** 現在の並べ替え対象の id 順（確定済みの一覧から読む。組み込みは含めない） */
  ids: () => string[];
  /** 並びを保存し、サーバーが採用した順を返す（PATCH /api/agents/order または /api/prompts/order） */
  save: (ids: string[]) => Promise<string[]>;
  /** 確定した順を一覧と共有カタログへ即時に反映する（同時に取得の世代を進める） */
  apply: (ids: string[]) => void;
  /** 確定後に一覧（と共有カタログ）を取り直す */
  refresh: () => Promise<unknown>;
  note: (kind: ReorderNoteKind, message: string) => void;
  /** 下書きと保存中の状態をページへ渡す */
  onChange: (state: ReorderState) => void;
};

export type ReorderFlow = {
  state(): ReorderState;
  /** ドラッグ中の live 差し替え。保存中は受け付けない */
  preview(ids: readonly string[]): void;
  /** ドラッグの取り消し。下書きを捨ててサーバーの確定順へ戻す */
  cancel(): void;
  /** 確定。ドラッグしていなければ何もしない */
  commit(): Promise<void>;
  /**
   * サーバーの正を取り込んだ（一覧 / カタログの更新）。**結果不明のまま残している下書きだけ**を捨てて
   * 表示をサーバーの並びへ戻す（各ページが取得の更新で呼ぶ）。
   */
  settle(): void;
};

export function createReorderFlow(options: ReorderFlowOptions): ReorderFlow {
  /** 応答が返らず結果不明のまま残している下書き。次の取得（settle）までだけ表示に残す */
  let unconfirmed = false;
  const draft = createOrderDraft({ ids: options.ids, onChange: options.onChange });

  return {
    state: () => draft.state(),

    preview(ids) {
      // 保存中で受け付けなかったときは、結果不明のまま残している下書きの印も変えない
      if (!draft.preview(ids)) return;
      unconfirmed = false;
    },

    cancel() {
      if (!draft.cancel()) return;
      unconfirmed = false;
    },

    settle() {
      if (!unconfirmed) return;
      unconfirmed = false;
      draft.discard();
    },

    async commit() {
      const ids = draft.begin();
      if (!ids) return;

      let saved: string[];
      try {
        saved = await options.save(ids);
      } catch (error) {
        if (error instanceof ApiError) {
          // HTTP エラーの応答は保存されていないため、元の順へ戻して理由を出す
          unconfirmed = false;
          draft.finish(null);
          options.note("rejected", messageFor(error));
        } else {
          // 応答が返らない失敗は保存結果が不明。表示は戻さず、**次の取得（settle）**でサーバーの正に合わせる
          unconfirmed = true;
          draft.finish(ids);
          options.note("unknown", messageFor(error));
        }
        return;
      }

      // 確定した順は、取り直しの応答を待たずに共有カタログへ反映する
      unconfirmed = false;
      options.apply(saved);
      draft.finish(null);
      try {
        await options.refresh();
      } catch (error) {
        // ローカルには確定順が残っているので、並びは戻さず「取り直せない」だけを伝える
        options.note("refresh", messageFor(error));
      }
    },
  };
}
