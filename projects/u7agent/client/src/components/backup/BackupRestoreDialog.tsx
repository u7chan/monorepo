import { useEffect, useRef, type FormEvent } from "react";
import { cn } from "../../lib/cn";
import {
  BACKUP_KEPT_NOTE,
  BACKUP_RESTORE_APPLYING_LABEL,
  BACKUP_RESTORE_APPLY_LABEL,
  BACKUP_RESTORE_CLOSE_LABEL,
  BACKUP_RESTORE_DELETE_CHECK_LABEL,
  BACKUP_RESTORE_DIALOG_TITLE,
  BACKUP_RESTORE_PLANNING_NOTE,
  BACKUP_SKILL_LIMITS_NOTE,
  BACKUP_STATUS_LABELS,
  BACKUP_TARGET_LABELS,
  backupBlockerText,
  backupCanApply,
  backupCountsSummary,
  backupNeedsDeleteConfirm,
  backupRemovedNames,
  backupTotalSummary,
  backupWarningTexts,
} from "../../lib/backup";
import type { BackupRestoreFlow } from "../../lib/backupFlow";
import type { BackupTargetPlan } from "../../types";

export type BackupRestoreDialogProps = {
  flow: Exclude<BackupRestoreFlow, { status: "idle" } | { status: "done" }>;
  singleColumn?: boolean;
  onToggleTarget: (target: "prompts" | "agents" | "skills") => void;
  onConfirmed: (value: boolean) => void;
  onApply: () => void;
  onClose: () => void;
};

/**
 * 復元のプレビュー兼確認ダイアログ。plan の件数・削除対象・警告・ブロッカーを出し、対象ごとの
 * 置き換えと削除の確認を取ってから適用する (docs/ui-layout.md)。
 * モーダルの標準挙動 (背面の inert 化 / Tab の拘束 / Escape) と焦点の復帰に任せる。
 */
export function BackupRestoreDialog({
  flow,
  singleColumn = false,
  onToggleTarget,
  onConfirmed,
  onApply,
  onClose,
}: BackupRestoreDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const busy = flow.status === "applying";
  const plan = flow.status === "review" || flow.status === "applying" ? flow.plan : null;
  const confirmed = flow.status === "review" || flow.status === "applying" ? flow.confirmed : false;
  const needsConfirm = plan ? backupNeedsDeleteConfirm(plan) : false;
  const canApply = plan ? backupCanApply(plan, confirmed) : false;
  const removed = plan ? backupRemovedNames(plan) : [];

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

  // 初期焦点は取り消し側に置く (削除を伴う操作を確認してから押させる)
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (flow.status === "review" && canApply) onApply();
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-modal="true"
      aria-label={BACKUP_RESTORE_DIALOG_TITLE}
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
        <h2 className="text-md font-semibold text-ink-strong">{BACKUP_RESTORE_DIALOG_TITLE}</h2>
      </header>

      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="grid min-h-0 flex-1 scrollbar-thin content-start gap-3 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed">
          <div className="grid gap-0.5">
            <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">FILE</span>
            <span className="min-w-0 truncate text-ink-strong" title={flow.fileName}>
              {flow.fileName}
            </span>
          </div>

          {flow.status === "planning" ? (
            <p className="break-words text-ink-soft">{BACKUP_RESTORE_PLANNING_NOTE}</p>
          ) : null}

          {plan ? (
            <>
              <p className="break-words text-ink-muted">{backupTotalSummary(plan)}</p>
              {plan.blocked ? (
                <p className="rounded-lg border border-warn/50 bg-warn/10 px-2.5 py-2 text-2xs leading-relaxed break-words text-warn">
                  {plan.plans
                    .flatMap((item) =>
                      item.blocker ? [`${BACKUP_TARGET_LABELS[item.target]}: ${backupBlockerText(item.blocker)}`] : [],
                    )
                    .join(" / ")}
                </p>
              ) : null}
              {!plan.changed && !plan.blocked ? (
                <p className="break-words text-ink-soft">選択した対象に変更はありません。</p>
              ) : null}

              {plan.plans.map((item) => (
                <TargetSection
                  key={item.target}
                  plan={item}
                  included={plan.manifest.targets.includes(item.target)}
                  selected={plan.selected.includes(item.target)}
                  busy={busy}
                  onToggle={onToggleTarget}
                />
              ))}

              {backupWarningTexts(plan.plans.flatMap((item) => item.warnings)).length > 0 ? (
                <div className="grid gap-1">
                  <h3 className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">警告</h3>
                  <ul className="grid gap-0.5 text-2xs leading-4 break-words text-warn">
                    {backupWarningTexts(plan.plans.flatMap((item) => item.warnings)).map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {removed.length > 0 ? (
                <div className="grid gap-1">
                  <h3 className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">削除される定義</h3>
                  <ul className="grid gap-0.5 text-2xs leading-4 break-words text-ink-soft">
                    {removed.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {needsConfirm ? (
                <label className="flex items-start gap-2 rounded-lg border border-warn/50 bg-warn/10 px-2.5 py-2 text-2xs leading-relaxed text-ink-strong">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-focus"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(event) => onConfirmed(event.currentTarget.checked)}
                  />
                  <span className="min-w-0 break-words">{BACKUP_RESTORE_DELETE_CHECK_LABEL}</span>
                </label>
              ) : null}

              <p className="text-2xs leading-relaxed break-words text-ink-muted">{BACKUP_KEPT_NOTE}</p>
              <p className="text-2xs leading-relaxed break-words text-ink-muted">{BACKUP_SKILL_LIMITS_NOTE}</p>
            </>
          ) : null}
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
          <button type="submit" disabled={busy || !canApply} className="btn-danger singleColumn:min-h-11">
            {busy ? BACKUP_RESTORE_APPLYING_LABEL : BACKUP_RESTORE_APPLY_LABEL}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function TargetSection({
  plan,
  included,
  selected,
  busy,
  onToggle,
}: {
  plan: BackupTargetPlan;
  included: boolean;
  selected: boolean;
  busy: boolean;
  onToggle: (target: "prompts" | "agents" | "skills") => void;
}) {
  return (
    <div className="grid gap-1 rounded-lg border border-line px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {included ? (
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <input
              type="checkbox"
              className="accent-focus"
              checked={selected}
              disabled={busy}
              onChange={() => onToggle(plan.target)}
            />
            <span className="min-w-0 truncate text-xs text-ink-strong">{BACKUP_TARGET_LABELS[plan.target]}</span>
          </label>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-ink-ghost">
            {BACKUP_TARGET_LABELS[plan.target]} (バックアップに含まれない)
          </span>
        )}
        <span className="shrink-0 text-2xs text-ink-ghost">{backupCountsSummary(plan.counts)}</span>
      </div>
      {plan.items.length > 0 ? (
        <ul className="grid gap-0.5 text-2xs leading-4 text-ink-muted">
          {plan.items.map((item) => (
            <li key={`${item.status}-${item.id}`} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={item.name}>
                {item.name}
              </span>
              <span className={cn("shrink-0", item.status === "removed" && "text-warn")}>
                {BACKUP_STATUS_LABELS[item.status] ?? item.status}
              </span>
            </li>
          ))}
          {plan.truncated ? <li className="text-ink-ghost">一覧は上限の件数まで表示しています</li> : null}
        </ul>
      ) : null}
      {plan.blocker ? (
        <p className="text-2xs leading-4 break-words text-warn">{backupBlockerText(plan.blocker)}</p>
      ) : null}
    </div>
  );
}
