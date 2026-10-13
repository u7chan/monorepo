/**
 * 設定 → スペースの行の ⋯ の出し分けと、削除の確認文言。既定スペースは削除できないので項目を持たず、
 * 追加スペースの削除は消える対象と選択の移り先を実行前に示す (docs/ui-layout.md#スペース)。
 * 文言を純関数に置くのは、client に DOM テスト基盤が無いため (`lib/sidebarRowMenu.ts` と同じ)。
 */
import type { Space } from "server";
import type { ConfirmRequest } from "./confirmDialog";
import type { RowMenuAction } from "./rowMenu";

export type SpaceRowKind = "delete";

/** 既定スペースは空配列 (項目 0 の行は ⋯ を出さない)。削除は他者から見ても取り消せないので danger にする */
export function spaceRowActions(isDefault: boolean): RowMenuAction<SpaceRowKind>[] {
  return isDefault ? [] : [{ kind: "delete", label: "スペースを削除", danger: true }];
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
