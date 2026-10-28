import { useEffect, useRef } from "react";
import type { AgentSuggestion } from "../../types";

export const SUGGESTION_DELETE_TITLE = "定型プロンプトを削除";
export const SUGGESTION_DELETE_BODY = "保存すると、このエージェントの定型プロンプトから外れます。";
export const SUGGESTION_DELETE_CONFIRM_LABEL = "削除する";
export const SUGGESTION_DELETE_CANCEL_LABEL = "やめる";

/**
 * 定型プロンプト 1 件の削除確認。共通の確認ダイアログ (`ConfirmDialog`) は対象が 1 つの値で、
 * 「取り消せない操作」を前提にした文面を持つ。ここは編集中のフォームの行を外すだけで、保存するまで
 * 何も起きないため、対象のラベルとプロンプト (どの行か) を並べ、保存で効くことを本文で伝える専用の面にする。
 */
export function SuggestionDeleteDialog({
  suggestion,
  index,
  onConfirm,
  onCancel,
}: {
  suggestion: AgentSuggestion;
  /** 1 始まりの並び。ラベルが空でもどの行かを伝えられるよう見出しへ添える */
  index: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      // 直前の cleanup でフォーカスが背面へ戻されている (StrictMode)
      dialog.focus();
    }
    // 破壊的な操作を Enter で確定させないよう、取り消す側から始める
    cancelRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      onClose={onCancel}
      aria-modal="true"
      aria-label={SUGGESTION_DELETE_TITLE}
      tabIndex={-1}
      // Escape はこの面だけを閉じる (設定ページの「戻る」など背面の keydown へ届かせない)
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      className="m-auto max-h-[min(88dvh,760px)] w-[min(420px,92vw)] overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink shadow-panel"
    >
      {/* 編集フォームの中に置くので form は使わない (入れ子の form は無効な HTML)。確定はボタンの click で受ける */}
      <div className="flex flex-col">
        <header className="shrink-0 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-strong">
            {SUGGESTION_DELETE_TITLE}
            <span className="ml-1.5 text-2xs font-normal text-ink-ghost tabular-nums">
              {String(index).padStart(2, "0")}
            </span>
          </h2>
        </header>

        <div className="grid min-h-0 content-start gap-2.5 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed">
          <div className="grid gap-0.5">
            <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">ラベル</span>
            <span className="line-clamp-2 min-w-0 break-words text-ink-strong">
              {suggestion.label === "" ? "（ラベルなし）" : suggestion.label}
            </span>
          </div>
          <div className="grid gap-0.5">
            <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">プロンプト</span>
            <span className="line-clamp-3 min-w-0 break-words whitespace-pre-wrap text-ink-soft">
              {suggestion.prompt === "" ? "（未入力）" : suggestion.prompt}
            </span>
          </div>
          <p className="break-words text-ink-soft">{SUGGESTION_DELETE_BODY}</p>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button ref={cancelRef} type="button" onClick={onCancel} className="btn-quiet">
            {SUGGESTION_DELETE_CANCEL_LABEL}
          </button>
          <button type="button" onClick={onConfirm} className="btn-danger">
            {SUGGESTION_DELETE_CONFIRM_LABEL}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
