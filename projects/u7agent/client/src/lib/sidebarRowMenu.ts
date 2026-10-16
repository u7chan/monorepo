/**
 * 左サイドバーの行の ⋯ メニューの出し分けと、その操作の確認文言だけを持つ。client に DOM テスト基盤が
 * 無いため、項目とラベルはこの純関数で固定する (`client/src/components/RowMenu.tsx` は設定 → ファイル と共有)。
 * 折りたたみ (行のボタン) と通知のベルは行に残すので、ここには出さない。
 */
import type { ConfirmRequest, PromptRequest } from "./confirmDialog";
import {
  DIAGNOSTICS_COPY_DESCRIPTION,
  DIAGNOSTICS_COPY_LABEL,
  DIAGNOSTICS_COPY_SERVER_ONLY,
  RAW_LOG_DESCRIPTION,
  RAW_LOG_LABEL,
  RAW_LOG_MISSING,
  RAW_LOG_NOTICE,
} from "./diagnostics";
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
export type SessionRowKind = "pin" | "rename" | "handoff" | "diagnostics" | "raw-log" | "delete";

/** セッション行の ⋯ の出し分けに使う状態。省略は「ピン無し / 引き継ぎ不可 / 開いていない / 生ログ無し」 */
export type SessionRowMenuOptions = {
  pinned?: boolean;
  /** 操作の受け取りがあるか (未指定 = 項目を出さない)。プロジェクト所属でも渡す */
  canHandoff?: boolean;
  /** このタブで開いている会話か (診断の説明行を切り替える) */
  open?: boolean;
  /** 生ログ (session.jsonl) が保存されているか */
  hasRawLog?: boolean;
  /** 引き継ぎを止める理由。空なら実行できる (項目ごと隠さず、理由を説明行へ出す) */
  handoffBlockedReason?: string;
};

/**
 * ピンの切替を先頭に置き、リネームは削除の手前に残す。引き継ぎは受取りがある行に出し、
 * 実行中・圧縮中・片付け中は無効にして理由を説明行へ出す (項目ごと隠さない)。
 */
export function sessionRowActions(options: SessionRowMenuOptions = {}): RowMenuAction<SessionRowKind>[] {
  const { pinned = false, canHandoff = false, open = false, hasRawLog = false, handoffBlockedReason = "" } = options;
  const handoff: RowMenuAction<SessionRowKind>[] = canHandoff
    ? [
        {
          kind: "handoff",
          label: "会話を引き継ぐ",
          description: handoffBlockedReason || "エージェント / スペースを変えて続けます。履歴は破棄されます",
          descriptionKind: "disclosure",
          disabled: handoffBlockedReason !== "",
        },
      ]
    : [];
  return [
    { kind: "pin", label: pinned ? "ピン留めを解除" : "ピン留め" },
    { kind: "rename", label: "名前を変更" },
    ...handoff,
    {
      kind: "diagnostics",
      label: DIAGNOSTICS_COPY_LABEL,
      description: open ? DIAGNOSTICS_COPY_DESCRIPTION : DIAGNOSTICS_COPY_SERVER_ONLY,
      // 何を含むか / 取れない理由は押す前に知る必要がある
      descriptionKind: "disclosure",
    },
    {
      kind: "raw-log",
      label: RAW_LOG_LABEL,
      description: hasRawLog ? RAW_LOG_DESCRIPTION : RAW_LOG_MISSING,
      descriptionKind: "disclosure",
      disabled: !hasRawLog,
    },
    { kind: "delete", label: "セッションを削除", danger: true },
  ];
}

/** 生ログの確認。開示のリスクは伝えるが、壊す操作ではないので danger トーンにしない */
export function rawLogConfirmRequest(title: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: RAW_LOG_LABEL,
    ...(title ? { subject: { label: "対象の会話", value: title } } : {}),
    body: [RAW_LOG_NOTICE],
    confirmLabel: "ダウンロードする",
  };
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
