import { useEffect, useRef, useState, type FormEvent } from "react";
import { cn } from "../../lib/cn";
import {
  BACKUP_KEPT_NOTE,
  BACKUP_RESET_APPLYING_LABEL,
  BACKUP_RESET_APPLY_LABEL,
  BACKUP_RESET_CHECK_LABEL,
  BACKUP_RESET_DIALOG_TITLE,
  BACKUP_RESTORE_CLOSE_LABEL,
  BACKUP_SKILL_LIMITS_NOTE,
  BACKUP_TARGET_LABELS,
  backupResetDoneNote,
} from "../../lib/backup";
import type { BackupResetFlow } from "../../lib/backupFlow";
import type { BackupExportCheck } from "../../types";

export type BackupResetDialogProps = {
  flow: Exclude<BackupResetFlow, { status: "idle" }>;
  /** 消える件数の見積り。取得できていないときは件数を出さない */
  check: BackupExportCheck | null;
  singleColumn?: boolean;
  onApply: () => void;
  onClose: () => void;
};

/**
 * 全削除の確認ダイアログ。件数と残るものを出し、「書き出し済み、または失ってもよい」のチェックを
 * 必須にする (docs/ui-layout.md)。実行は元に戻せないため danger トーンに揃える。
 */
export function BackupResetDialog({ flow, check, singleColumn = false, onApply, onClose }: BackupResetDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const busy = flow.status === "applying";
  const done = flow.status === "done";

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

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (flow.status === "confirm" && confirmed) onApply();
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-modal="true"
      aria-label={BACKUP_RESET_DIALOG_TITLE}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      className={cn(
        "flex flex-col overflow-hidden border-line bg-panel p-0 text-ink",
        singleColumn
          ? "m-0 h-dvh max-h-none w-screen max-w-none rounded-none border-0"
          : "m-auto max-h-[min(88dvh,760px)] w-[min(560px,92vw)] rounded-xl border shadow-panel",
      )}
    >
      <header className="shrink-0 border-b border-line px-4 py-3.5">
        <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">BACKUP</div>
        <h2 className="text-md font-semibold text-ink-strong">{BACKUP_RESET_DIALOG_TITLE}</h2>
      </header>

      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="grid min-h-0 flex-1 scrollbar-thin content-start gap-3 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed">
          <p className="break-words text-ink-soft">
            ユーザー定義のエージェント、自作の定型プロンプト、共通スキルを削除します。元に戻せません。
          </p>
          {check ? (
            <p className="break-words text-ink-strong">
              削除する件数:{" "}
              {check.entries.map((entry) => `${BACKUP_TARGET_LABELS[entry.target]} ${entry.count} 件`).join(" / ")}
            </p>
          ) : null}
          <p className="text-2xs leading-relaxed break-words text-ink-muted">{BACKUP_KEPT_NOTE}</p>
          <p className="text-2xs leading-relaxed break-words text-ink-muted">{BACKUP_SKILL_LIMITS_NOTE}</p>
          {done ? (
            <p className="break-words text-ink-soft">{backupResetDoneNote(flow.result)}</p>
          ) : (
            <label className="flex items-start gap-2 rounded-lg border border-warn/50 bg-warn/10 px-2.5 py-2 text-2xs leading-relaxed text-ink-strong">
              <input
                type="checkbox"
                className="mt-0.5 accent-focus"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
              />
              <span className="min-w-0 break-words">{BACKUP_RESET_CHECK_LABEL}</span>
            </label>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn-quiet singleColumn:min-h-11"
          >
            {BACKUP_RESTORE_CLOSE_LABEL}
          </button>
          {done ? null : (
            <button type="submit" disabled={busy || !confirmed} className="btn-danger singleColumn:min-h-11">
              {busy ? BACKUP_RESET_APPLYING_LABEL : BACKUP_RESET_APPLY_LABEL}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}
