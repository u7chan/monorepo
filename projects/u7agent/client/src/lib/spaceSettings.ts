/**
 * 設定 → スペースの行の ⋯ の出し分けと、改名・削除の文言。既定スペースは改名も削除もできないので項目を
 * 持たず（⋯ ごと出さない）、追加スペースの削除は消える対象と選択の移り先を実行前に示す
 * (docs/ui-layout.md#スペース)。文言を純関数に置くのは、client に DOM テスト基盤が無いため
 * (`lib/sidebarRowMenu.ts` と同じ)。
 */
import type { Space } from "server";
import type { ConfirmRequest, PromptRequest } from "./confirmDialog";
import type { RowMenuAction } from "./rowMenu";

export type SpaceRowKind = "rename" | "delete";

/** 既定スペースは空配列 (項目 0 の行は ⋯ を出さない)。削除は他者から見ても取り消せないので danger にする */
export function spaceRowActions(isDefault: boolean): RowMenuAction<SpaceRowKind>[] {
  return isDefault
    ? []
    : [
        { kind: "rename", label: "名前を変更" },
        { kind: "delete", label: "スペースを削除", danger: true },
      ];
}

/**
 * 改名の入力。表示名しか変えないことを本文で示し、現在の名前を必ず初期値に入れる
 * (設定 → ファイル / 共有物の改名と同じ規則で、空欄・未変更は `renameInputValue` が捨てる)。
 */
export function spaceRenameRequest(space: Space): PromptRequest {
  return {
    kind: "prompt",
    title: "名前を変更",
    subject: { label: "名前を変更する会話スペース", value: space.name },
    label: "新しい名前",
    defaultValue: space.name,
    body: [
      "表示名だけを変えます。会話の所属・作業フォルダ・添付は変わりません。",
      "名前は 1〜80 文字で指定してください。",
    ],
    confirmLabel: "変更する",
  };
}

/**
 * 削除の確認。会話の件数は出さず、消える対象と実行中・選択中の帰結だけを示す
 * (`docs/ui-layout.md#スペース`。件数を出すには一覧 DTO か別 API が要り、他タブで古くなる)。
 */
export function spaceDeleteConfirmRequest(space: Space): ConfirmRequest {
  return {
    kind: "confirm",
    title: "会話スペースを削除",
    subject: { label: "削除する会話スペース", value: space.name },
    body: ["会話・履歴・作業フォルダのファイル・添付・環境変数とサービス実績を消します。元に戻せません。"],
    notes: ["実行中の会話は停止されます。", "選択中のスペースを削除すると、既定スペースへ切り替わります。"],
    confirmLabel: "削除する",
    danger: true,
  };
}
