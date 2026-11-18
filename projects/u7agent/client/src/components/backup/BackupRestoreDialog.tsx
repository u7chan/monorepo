import { useRef, type FormEvent } from "react";
import { cn } from "../../lib/cn";
import {
  BACKUP_KEPT_NOTE,
  BACKUP_RESTORE_APPLYING_LABEL,
  BACKUP_RESTORE_APPLY_LABEL,
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
  backupTargetPlanOf,
  backupTotalSummary,
  backupWarningTexts,
} from "../../lib/backup";
import type { BackupRestoreFlow } from "../../lib/backupFlow";
import type { BackupTarget, BackupTargetPlan } from "../../types";
import { WorkDialog } from "../WorkDialog";

export type BackupRestoreDialogProps = {
  flow: Exclude<BackupRestoreFlow, { status: "idle" } | { status: "done" }>;
  singleColumn?: boolean;
  onToggleTarget: (target: BackupTarget) => void;
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
  const closeRef = useRef<HTMLButtonElement>(null);
  const busy = flow.status === "applying";
  const plan = flow.status === "review" || flow.status === "applying" ? flow.plan : null;
  const confirmed = flow.status === "review" || flow.status === "applying" ? flow.confirmed : false;
  const needsConfirm = plan ? backupNeedsDeleteConfirm(plan) : false;
  const canApply = plan ? backupCanApply(plan, confirmed) : false;
  const removed = plan ? backupRemovedNames(plan) : [];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (flow.status === "review" && canApply) onApply();
  };

  return (
    <WorkDialog
      eyebrow="BACKUP"
      title={BACKUP_RESTORE_DIALOG_TITLE}
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
      initialFocusRef={closeRef}
      submit={{
        label: busy ? BACKUP_RESTORE_APPLYING_LABEL : BACKUP_RESTORE_APPLY_LABEL,
        tone: "danger",
        disabled: busy || !canApply,
      }}
      width="wide"
      body="dense"
      singleColumn={singleColumn}
    >
      <div className="grid gap-0.5">
        <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">FILE</span>
        <span className="min-w-0 truncate text-ink-strong" title={flow.fileName}>
          {flow.fileName}
        </span>
      </div>

      {flow.status === "planning" ? <p className="break-words text-ink-soft">{BACKUP_RESTORE_PLANNING_NOTE}</p> : null}

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

          {/* 行は manifest の全対象ぶん出す。OFF にした対象は plan から消えるため、
                  plans を回すとトグルが消えて再 ON できなくなる */}
          {plan.manifest.targets.map((target) => (
            <TargetSection
              key={target}
              target={target}
              plan={backupTargetPlanOf(plan, target)}
              selected={plan.selected.includes(target)}
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
    </WorkDialog>
  );
}

function TargetSection({
  target,
  plan,
  selected,
  busy,
  onToggle,
}: {
  target: BackupTarget;
  /** 置き換えない対象は plan に載らない (件数も差分も出さない) */
  plan: BackupTargetPlan | undefined;
  selected: boolean;
  busy: boolean;
  onToggle: (target: BackupTarget) => void;
}) {
  return (
    <div className="grid gap-1 rounded-lg border border-line px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <input
            type="checkbox"
            className="accent-focus"
            checked={selected}
            disabled={busy}
            onChange={() => onToggle(target)}
          />
          <span className="min-w-0 truncate text-xs text-ink-strong">{BACKUP_TARGET_LABELS[target]}</span>
        </label>
        <span className="shrink-0 text-2xs text-ink-ghost">
          {plan ? backupCountsSummary(plan.counts) : "置き換えない"}
        </span>
      </div>
      {plan && plan.items.length > 0 ? (
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
      {plan?.blocker ? (
        <p className="text-2xs leading-4 break-words text-warn">{backupBlockerText(plan.blocker)}</p>
      ) : null}
    </div>
  );
}
