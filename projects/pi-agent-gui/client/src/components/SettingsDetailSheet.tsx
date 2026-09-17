import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { CloseIcon } from "./icons";

export type SettingsDetailSheetProps = {
  /** ヘッダの小見出し (例: AGENT) */
  eyebrow: string;
  /** ヘッダの見出し (例: エージェントを編集) */
  title: string;
  /** 背面に隠れるページの note。シートを開いたまま出るエラーを読めるようにここへも出す */
  note?: { text: string; error: boolean };
  onClose: () => void;
  /** スクロールする本文と固定アクション行。高さを埋めるのは中身 (編集フォーム) の責任 */
  children: ReactNode;
};

/**
 * compact で「一覧 (ページ) + 詳細 (全画面シート)」に分けるときの詳細側。
 * モーダル dialog にして、背面の inert 化と Tab のフォーカス拘束、Escape での終了を showModal() の標準挙動に任せる。
 * ページ (SettingsPageLayout) と違い dialog を被せるのは、背面の一覧が選択のためだけの領域で、閉じれば戻る先になるため。
 */
export function SettingsDetailSheet({ eyebrow, title, note, onClose, children }: SettingsDetailSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
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
    return () => previousFocusRef.current?.focus();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      tabIndex={-1}
      aria-modal="true"
      aria-label={title}
      // Escape は dialog の標準挙動でも閉じるが、keydown は window まで伝播して App が設定ページごと
      // チャットへ戻す。ここで止めて、1 回の Escape でシートだけを閉じる (2 回目はページが受ける)
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      className="m-0 flex h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden rounded-none border-0 bg-panel p-0 text-ink"
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">{eyebrow}</div>
          <h2 className="font-semibold text-base text-ink-strong">{title}</h2>
        </div>
        <button type="button" onClick={onClose} className="btn-quiet">
          <CloseIcon />
          閉じる
        </button>
      </header>

      {children}

      {/* ページの note 行と同じ位置 (最下段) に置き、シートを閉じたあとの見え方と揃える */}
      {note ? (
        <div
          aria-live="polite"
          className={cn(
            "shrink-0 border-t border-line px-4 py-2.5 text-1xs break-words",
            note.error ? "text-danger-text" : "text-ink-muted",
          )}
        >
          {note.text}
        </div>
      ) : null}
    </dialog>
  );
}
