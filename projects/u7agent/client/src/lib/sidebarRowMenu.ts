/**
 * 左サイドバーの行の ⋯ メニューの出し分けと、その操作の確認文言だけを持つ。client に DOM テスト基盤が
 * 無いため、項目とラベルはこの純関数で固定する (`client/src/components/RowMenu.tsx` は設定 → ファイル と共有)。
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
export type SessionRowKind = "rename" | "delete";

/** 設定 → ファイル のフォルダと同じく、リネームは削除の手前に置く (取り消せる操作を先に出す) */
export function sessionRowActions(): RowMenuAction<SessionRowKind>[] {
  return [
    { kind: "rename", label: "名前を変更" },
    { kind: "delete", label: "セッションを削除", danger: true },
  ];
}

/**
 * リネームの入力の見出し。初期値 (現在のタイトル) は呼び出し側が window.prompt の第 2 引数で渡す。
 * 空にすると自動タイトルへは戻らない (次にメッセージを送るまで `無題のセッション` になる) ので、
 * 取り消しと同じく空入力は何もしない扱いにする。
 */
export function sessionRenamePrompt(): string {
  return "セッションの新しい名前を入力してください。";
}
