/**
 * 会話タイトルの AI 要約の状態を、行メニュー・ダイアログ・完了のお知らせで同じ言葉にするための純関数。
 * 色は「状態の意味」だけを持ち、チップ (面) ではなく点と文字で出す。
 */
import type { ConfirmRequest } from "./confirmDialog";
import type { SessionTitleSummary, TitleSkipReason } from "../types";

export type SessionTitleTone = "accent" | "danger" | "warn" | "muted";

export type SessionTitleStatus = {
  /** 短い状態名。行メニューの右端に出す */
  text: string;
  tone: SessionTitleTone;
  /** 実行しなかった理由。ダイアログとお知らせの本文に出す */
  description?: string;
};

/** skipped の理由を利用者向けの 1 文にする。未知 / 欠落は「対象外」に倒す */
export function sessionTitleSkipReasonText(reason: TitleSkipReason | undefined): string {
  switch (reason) {
    case "disabled":
      return "AI要約は Off です";
    case "model-unset":
      return "要約モデルが選択されていません";
    case "manual":
      return "手動で変更したタイトルを保護しました";
    case "no-request":
      return "依頼本文がないため対象外です";
    case "cancelled":
      return "設定の変更または停止で取り消しました";
    case "settings-changed":
      return "設定が変わったため結果を適用しませんでした";
    case "not-ready":
      return "会話が実行中のためスキップしました";
    case "interrupted":
      return "再起動で中断しました";
    default:
      return "要約の対象外です";
  }
}

/** 最新の試行から表示状態を引く。試行が無い会話は「未実行」 */
export function sessionTitleStatusOf(summary: SessionTitleSummary | undefined): SessionTitleStatus {
  const attempt = summary?.attempt;
  if (!attempt) return { text: "未実行", tone: "muted" };
  switch (attempt.state) {
    case "pending":
      return { text: "実行中", tone: "warn", description: "AI要約を実行しています" };
    case "done":
      return { text: "済み", tone: "accent", description: "AI要約でタイトルを更新しました" };
    case "failed":
      return {
        text: "失敗",
        tone: "danger",
        description: attempt.error ? `AI要約に失敗しました: ${attempt.error}` : "AI要約に失敗しました",
      };
    case "skipped":
      return {
        text: attempt.skipReason === "disabled" ? "無効" : "スキップ",
        tone: "muted",
        description: sessionTitleSkipReasonText(attempt.skipReason),
      };
  }
}

/** 完了のお知らせの本文。状態ごとにタイトル / 理由を 1 文へまとめる */
export function sessionTitleNoticeText(
  summary: SessionTitleSummary | undefined,
  title: string,
): { heading: string; detail: string; tone: SessionTitleTone } {
  const attempt = summary?.attempt;
  const status = sessionTitleStatusOf(summary);
  if (attempt?.state === "done") {
    return { heading: "タイトルをAI要約で更新しました", detail: title, tone: "accent" };
  }
  if (attempt?.state === "failed") {
    return {
      heading: "AI要約に失敗しました",
      detail: attempt.error ?? "理由は不明です",
      tone: "danger",
    };
  }
  return {
    heading: attempt?.state === "skipped" ? "AI要約をスキップしました" : "AI要約の状態が変わりました",
    detail: status.description ?? "",
    tone: status.tone,
  };
}

/** 再要約の確認。手動で付けた名前を AI が置き換えることは、押す前に伝える */
export function sessionTitleResummarizeConfirmRequest(
  title: string,
  summary: SessionTitleSummary | undefined,
): ConfirmRequest {
  return {
    kind: "confirm",
    title: "AI要約をやり直す",
    ...(title ? { subject: { label: "対象の会話", value: title } } : {}),
    body: [
      summary?.origin === "manual"
        ? "手動で変更したタイトルを、新しい AI 要約で置き換えます。"
        : "現在のタイトルを、新しい AI 要約で置き換えます。",
      "要約モデルへの送信が 1 回発生します。",
    ],
    confirmLabel: "再要約する",
  };
}
