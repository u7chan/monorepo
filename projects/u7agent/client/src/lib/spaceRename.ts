/**
 * 設定 → スペースの改名の保存と反映。要求は 1 本の待ち行列で直列化し、応答は届いた順に一覧の該当行だけへ
 * 反映する (後着だけを採用すると、先の成功と後の 400 で画面と DB が乖離する)。
 */
import type { Space } from "server";
import { ApiError } from "../api/http";
import { messageFor } from "./errors";

/** 失敗の分類。文言は `spaceRenameNoteText` が持ち、ここは分類だけを渡す */
export type SpaceRenameNoteKind =
  /** HTTP エラーの応答。保存されていないので表示は変えない */
  | "rejected"
  /** 応答が返らない失敗（接続断 / タイムアウト）。保存結果が不明なので再読み込みでサーバーへ合わせる */
  | "unknown";

export type SpaceRenameFlowOptions = {
  /** 改名を保存し、改名後の `space` を返す（PATCH /api/spaces/:id） */
  save: (id: string, name: string) => Promise<Space>;
  /** 応答の行を一覧の該当行だけに反映する */
  apply: (space: Space) => void;
  note: (kind: SpaceRenameNoteKind, message: string) => void;
};

export type SpaceRenameFlow = {
  /** 改名を待ち行列へ入れる。前の要求が返ってから送り、失敗は `note` に渡す */
  rename: (id: string, name: string) => Promise<void>;
};

/** 失敗の文言。並べ替え（`SpaceSettingsPage`）と同じく、保存されたかどうかで伝えることを分ける */
export function spaceRenameNoteText(kind: SpaceRenameNoteKind, message: string): string {
  if (kind === "rejected") return `スペースの名前を変更できませんでした。${message}`;
  return `スペースの名前を変更できたか確認できません。再読み込みするとサーバーの名前に合わせます。（${message}）`;
}

export function createSpaceRenameFlow(options: SpaceRenameFlowOptions): SpaceRenameFlow {
  // 直列化は queue の連結だけで行う。失敗した改名の次も送れるよう、要求の成否で queue を切らない
  let queue: Promise<void> = Promise.resolve();

  return {
    rename(id, name) {
      const request = queue.then(async () => {
        try {
          options.apply(await options.save(id, name));
        } catch (error) {
          options.note(error instanceof ApiError ? "rejected" : "unknown", messageFor(error));
        }
      });
      queue = request;
      return request;
    },
  };
}
