/**
 * 設定 → 会話スペース（/settings/spaces）の並べ替えの保存と反映。ドラッグの下書きはページが持ち、
 * 確定時の手順（保存 → 一覧へマージ）と失敗の分類だけをここへ閉じる。下書きと送信の直列化は
 * `lib/orderDraft.ts` が持つ。
 *
 * **取り直し（refresh）を持たない**: スペース一覧の取得経路は初回 mount と復旧画面の明示的な再取得だけで、
 * エージェントのような共有カタログの取り直しと組にできない。そのため結果不明の下書きはページに残したまま
 * 保存中だけを解除し、**ページを離れた時点で捨てて `SpacesApp` が持つ最後に確定した順へ戻す**
 * （サーバーには保存されたが応答だけ失われた場合、これで戻るのは最後にクライアントが確定した順。
 * F5 など既存の再取得が走ったときに GET の順へ合う。docs/ui-layout.md#スペース）。
 * **離脱前に始めた保存の応答も反映しない**（`capture`）。一覧はページより長生きするので、古い応答が
 * 新しいページの確定した並びを巻き戻さないようにする。
 */
import { ApiError } from "../api";
import { messageFor } from "./errors";
import { createOrderDraft, type OrderDraftState } from "./orderDraft";

export type SpaceOrderState = OrderDraftState;

/** 通知の種類。文言はページが持ち、ここは分類だけを渡す */
export type SpaceOrderNoteKind =
  /** HTTP エラーの応答。保存されていないので元の順へ戻す */
  | "rejected"
  /** 応答が返らない失敗（接続断 / タイムアウト）。保存結果が不明なので表示は戻さない */
  | "unknown";

export type SpaceOrderFlowOptions = {
  /** 現在の確定順（既定スペースを除く id） */
  ids: () => string[];
  /** 並びを保存し、サーバーが採用した順を返す（PATCH /api/spaces/order） */
  save: (ids: readonly string[]) => Promise<readonly string[]>;
  /** 確定した順を現在の一覧へマージする（渡されなかった行は元の位置に残す） */
  apply: (ids: readonly string[]) => void;
  /**
   * 保存の応答を反映してよいかの判定を捕る（`createMountScope().capture()`。**確定を始める前に呼ぶ**）。
   * 一覧はページより長生きするので、保存を始めたページを離れた / 作り直された後の応答は反映しない: これを
   * 見ないと、離脱前に始めた古い保存の応答が、新しいページの確定した並びを巻き戻す（docs/ui-layout.md#スペース）。
   */
  capture: () => () => boolean;
  note: (kind: SpaceOrderNoteKind, message: string) => void;
  /** 下書きと保存中の状態をページへ渡す */
  onChange: (state: SpaceOrderState) => void;
};

export type SpaceOrderFlow = {
  state(): SpaceOrderState;
  /** ドラッグ中の live 差し替え。保存中は受け付けない */
  preview(ids: readonly string[]): void;
  /** ドラッグの取り消し。下書きを捨てて確定済みの順へ戻す */
  cancel(): void;
  /** 確定。ドラッグしていなければ何もしない */
  commit(): Promise<void>;
};

export function createSpaceOrderFlow(options: SpaceOrderFlowOptions): SpaceOrderFlow {
  const draft = createOrderDraft({ ids: options.ids, onChange: options.onChange });

  return {
    state: () => draft.state(),
    preview(ids) {
      draft.preview(ids);
    },
    cancel() {
      draft.cancel();
    },

    async commit() {
      // 応答の反映可否は保存を始める前に捕る (離脱・再生成を跨いだ古い応答を捨てる)
      const canApply = options.capture();
      const ids = draft.begin();
      if (!ids) return;

      let saved: readonly string[];
      try {
        saved = await options.save(ids);
      } catch (error) {
        // 離脱後は共有の一覧にも、もう無いページの note にも触らない
        if (!canApply()) return;
        if (error instanceof ApiError) {
          // HTTP エラーの応答は保存されていないため、元の順へ戻して理由を出す
          draft.finish(null);
          options.note("rejected", messageFor(error));
        } else {
          // 応答が返らない失敗は保存結果が不明。下書きは残したまま、次のドラッグは開始できるようにする
          draft.finish(ids);
          options.note("unknown", messageFor(error));
        }
        return;
      }

      // 保存を始めたページを離れた / 作り直された後の応答は、新しいページの確定順を巻き戻さないために捨てる
      if (!canApply()) return;
      // 確定した順は、応答に入っていない行（応答待ちの間に作られた行）をその場に残して一覧へ反映する
      options.apply(saved);
      draft.finish(null);
    },
  };
}
