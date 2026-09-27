/**
 * 左サイドバーの行の ⋯ メニューの出し分けだけを持つ。client に DOM テスト基盤が無いため、項目と
 * ラベルはこの純関数で固定する (`client/src/components/RowMenu.tsx` は設定 → ファイル と共有)。
 * 折りたたみ (行のボタン) と通知のベルは行に残すので、ここには出さない。
 */
import type { RowMenuAction } from "./rowMenu";

/** プロジェクト行の ⋯ の種別 (開閉は行のボタン、通知はベルが持つ) */
export type ProjectRowKind = "new-chat" | "delete";

/** プロジェクト行の ⋯。開いた行も保存する (畳んだ行から始めた会話の所属が左バーで見えるように) */
export function projectRowActions(): RowMenuAction<ProjectRowKind>[] {
  return [
    { kind: "new-chat", label: "このプロジェクトに新しい会話" },
    { kind: "delete", label: "プロジェクトを削除", danger: true },
  ];
}

/** セッション行の ⋯ の種別 (通知のベルは状態の印なのでメニューへ移さない) */
export type SessionRowKind = "delete";

export function sessionRowActions(): RowMenuAction<SessionRowKind>[] {
  return [{ kind: "delete", label: "セッションを削除", danger: true }];
}
