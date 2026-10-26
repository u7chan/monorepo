import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { useSpaceApi } from "../SpaceContext";
import { cn } from "../lib/cn";
import { effortLabel } from "../lib/composerSettings";
import { fileTimeLabel } from "../lib/messageTime";
import { formatCost } from "../lib/usageFormat";
import {
  sessionTitleResummarizeConfirmRequest,
  sessionTitleStatusOf,
  type SessionTitleTone,
} from "../lib/sessionTitleStatus";
import type { SessionTitleSummary } from "../types";
import { useConfirm } from "./ConfirmProvider";
import { CloseIcon, RunSpinnerIcon, SparkleIcon, WarningIcon } from "./icons";

const DOT_TONE: Record<SessionTitleTone, string> = {
  accent: "dot-accent",
  danger: "dot-danger",
  warn: "dot-warn",
  muted: "dot-idle",
};

const TEXT_TONE: Record<SessionTitleTone, string> = {
  accent: "text-accent-text",
  danger: "text-danger-text",
  warn: "text-warn-text",
  muted: "text-ink-faint",
};

/**
 * 会話の AI 要約の状態と再要約。デスクトップはモーダル、singleColumn は下から出るボトムシート。
 * 状態は点 + 文字で出し、チップ (面) は使わない (狭いヘッダや一覧に常設しない方針)。
 */
export function SessionTitleDialog({
  sessionId,
  title,
  titleSummary,
  onClose,
  onOpenSettings,
  onUpdated,
}: {
  sessionId: string;
  title: string;
  titleSummary?: SessionTitleSummary;
  onClose: () => void;
  onOpenSettings: () => void;
  /** 再要約の結果を一覧へ取り直させる (生成の失敗でも試行が変わるため呼ぶ) */
  onUpdated: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const api = useSpaceApi();
  const confirm = useConfirm();
  const [currentTitle, setCurrentTitle] = useState(title);
  const [currentSummary, setCurrentSummary] = useState(titleSummary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      dialog.focus();
    }
    return () => previousFocusRef.current?.focus();
  }, []);

  // 一覧の取り直し / 別タブの更新で親の値が変わったら追随する。再要約の応答は先に local へ入る
  useEffect(() => {
    setCurrentTitle(title);
    setCurrentSummary(titleSummary);
  }, [sessionId, title, titleSummary]);

  const status = sessionTitleStatusOf(currentSummary);
  const attempt = currentSummary?.attempt;
  const pending = busy || attempt?.state === "pending";

  const resummarize = async () => {
    if (!(await confirm(sessionTitleResummarizeConfirmRequest(currentTitle, currentSummary)))) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.summarizeSessionTitle(sessionId);
      setCurrentTitle(result.title);
      setCurrentSummary(result.titleSummary);
      onUpdated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-modal="true"
      aria-label="AI要約"
      aria-busy={pending}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      className="m-auto flex max-h-[min(88dvh,760px)] w-[min(560px,92vw)] flex-col overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink shadow-panel singleColumn:m-0 singleColumn:mt-auto singleColumn:w-screen singleColumn:max-w-none singleColumn:rounded-b-none"
    >
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 text-accent-text">
            <SparkleIcon />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink-strong">AI要約</h2>
            <p className="text-2xs text-ink-faint">この会話のタイトル</p>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="閉じる" className="icon-button size-8">
          <CloseIcon />
        </button>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto px-4 py-3.5 text-xs">
        <div className="grid gap-1">
          <span className="text-2xs font-semibold tracking-label text-ink-faint uppercase">現在のタイトル</span>
          <div className="rounded-lg border border-line bg-raised px-3 py-2 text-sm break-words text-ink-strong">
            {currentTitle || "無題のセッション"}
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("dot", DOT_TONE[status.tone])} aria-hidden />
          <span className={cn("font-semibold", TEXT_TONE[status.tone])}>{status.text}</span>
          {attempt ? <span className="text-ink-faint">{fileTimeLabel(attempt.at)}</span> : null}
          {attempt?.trigger === "manual" ? <span className="text-ink-faint">・会話メニューから</span> : null}
        </div>

        {attempt ? (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-line bg-soft px-3 py-2.5">
            <div className="min-w-0">
              <dt className="text-2xs text-ink-faint">モデル</dt>
              <dd className="break-all text-ink-soft">{attempt.model ?? "—"}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-2xs text-ink-faint">Effort</dt>
              <dd className="text-ink-soft">{attempt.thinkingLevel ? effortLabel(attempt.thinkingLevel) : "—"}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-2xs text-ink-faint">トークン</dt>
              <dd className="text-ink-soft">
                {attempt.inputTokens === undefined && attempt.outputTokens === undefined
                  ? "—"
                  : `入力 ${attempt.inputTokens ?? 0} / 出力 ${attempt.outputTokens ?? 0}`}
                {attempt.costTotal === undefined ? "" : ` ・ ${formatCost(attempt.costTotal)}`}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-2xs text-ink-faint">所要時間</dt>
              <dd className="text-ink-soft">
                {attempt.durationMs === undefined ? "—" : `${(attempt.durationMs / 1000).toFixed(1)} 秒`}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="rounded-lg border border-line bg-soft px-3 py-2.5 leading-relaxed text-ink-soft">
            この会話ではまだ AI 要約を実行していません。再要約を押すと、保存済みのモデルと Effort で 1
            回だけ実行します。
          </p>
        )}

        {attempt?.state === "failed" ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-danger/40 bg-raised px-3 py-2.5 text-danger-text"
          >
            <span className="mt-0.5 shrink-0">
              <WarningIcon />
            </span>
            <p className="min-w-0 leading-relaxed break-words">{attempt.error ?? "AI要約に失敗しました"}</p>
          </div>
        ) : null}
        {status.description && attempt?.state !== "failed" && attempt?.state !== "done" ? (
          <p className="rounded-lg border border-line bg-soft px-3 py-2.5 leading-relaxed text-ink-soft">
            {status.description}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="leading-relaxed break-words text-danger-text">
            {error}
          </p>
        ) : null}
      </div>

      <footer className="grid gap-2 border-t border-line px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={onClose} className="btn-quiet">
            閉じる
          </button>
          <button type="button" onClick={() => void resummarize()} disabled={pending} className="btn-primary">
            {pending ? <RunSpinnerIcon tone="on-accent" /> : <SparkleIcon />}
            {pending ? "要約中…" : "再要約"}
          </button>
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          className="justify-self-start text-xs text-accent-text underline underline-offset-2 hover:text-accent"
        >
          設定を開く
        </button>
      </footer>
    </dialog>
  );
}
