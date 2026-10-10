/**
 * 左サイドバーの行の ⋯ メニューの出し分けと、その操作の確認文言だけを持つ。client に DOM テスト基盤が
 * 無いため、項目とラベルはこの純関数で固定する (`client/src/components/RowMenu.tsx` は設定 → ファイル と共有)。
 * 折りたたみ (行のボタン) と通知のベルは行に残すので、ここには出さない。
 */
import type { ConfirmRequest, PromptRequest } from "./confirmDialog";
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

/** セッション行の ⋯ の種別 (通知のベルとピンは状態の印として行にも残す) */
export type SessionRowKind = "pin" | "rename" | "move" | "delete";

/**
 * ピンの切替を先頭に置き、リネームは削除の手前に残す。引っ越しはプロジェクト所属の会話では
 * 選べない (移動先の候補はあるが、サーバーが 400 にする) ので、`canMove` のときだけ出す。
 */
export function sessionRowActions(pinned = false, canMove = false): RowMenuAction<SessionRowKind>[] {
  const move: RowMenuAction<SessionRowKind>[] = canMove ? [{ kind: "move", label: "別のスペースへ引っ越す" }] : [];
  return [
    { kind: "pin", label: pinned ? "ピン留めを解除" : "ピン留め" },
    { kind: "rename", label: "名前を変更" },
    ...move,
    { kind: "delete", label: "セッションを削除", danger: true },
  ];
}

/**
 * セッション削除の確認。履歴が消えること・作業フォルダのファイルは残ること・実行中の処理が止まることを伝え、
 * 対象のタイトルは clamp した独立した行へ出す。
 */
export function sessionDeleteConfirmRequest(title: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: "セッションを削除",
    ...(title ? { subject: { label: "削除するセッション", value: title } } : {}),
    body: ["履歴を削除します。作業フォルダのファイルは残ります。実行中の処理は停止されます。"],
    confirmLabel: "削除する",
    danger: true,
  };
}

/**
 * リネームの入力。初期値 (現在のタイトル) は入力欄へ入れ、空・未変更は取り消しと同じで何もしない
 * (空にすると自動タイトルへは戻らないため、`renameInputValue` が弾く)。
 */
export function sessionRenameRequest(currentTitle: string): PromptRequest {
  return {
    kind: "prompt",
    title: "名前を変更",
    body: ["セッションの新しい名前を入力してください。"],
    label: "新しい名前",
    defaultValue: currentTitle,
    confirmLabel: "名前を変更",
  };
}

/**
 * 引っ越しの確認文言。履歴が消える不可逆な操作なので、破棄されるものと引き継がれるものを
 * 実行前に並べ、移動先の選択と一緒に専用ダイアログへ出す (共有の `DialogRequest` に `select` を足さない)。
 */
export type SessionMoveDialogText = {
  title: string;
  subject?: { label: string; value: string };
  body: readonly string[];
  /** 移動先の候補が無いときの案内。確定は無効にする */
  emptyNote: string;
  /** 実行前の補足。切替を伴わないこと (移動先の一覧は設定から選ぶ) を伝える */
  note: string;
  confirmLabel: string;
};

export function sessionMoveDialogText(title: string): SessionMoveDialogText {
  return {
    title: "別のスペースへ引っ越す",
    ...(title ? { subject: { label: "引っ越すセッション", value: title } } : {}),
    body: [
      "会話履歴（メッセージと未送信）は破棄されます。元に戻せません。",
      "作業フォルダのファイルと添付は、移動先のスペースへ引き継がれます。",
    ],
    emptyNote: "移動先のスペースがありません（設定 → スペースで作成してください）。",
    note: "この画面は移動先のスペースへ切り替わりません。移動先の会話は、スペースを切り替えてから開きます。",
    confirmLabel: "引っ越す",
  };
}
