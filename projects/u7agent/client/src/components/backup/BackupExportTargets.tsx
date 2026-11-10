import { cn } from "../../lib/cn";
import {
  BACKUP_TARGET_LABELS,
  backupExportBlockReason,
  backupExportCountOf,
  backupExportSummary,
} from "../../lib/backup";
import type { BackupExportCheck, BackupTarget } from "../../types";

export type BackupExportTargetsProps = {
  /** 書き出す対象。既定は全部 ON */
  targets: readonly BackupTarget[];
  all: readonly BackupTarget[];
  /** 書き出しの見積り。取得できていない間は件数を出さない */
  check: BackupExportCheck | null;
  disabled?: boolean;
  onToggle: (target: BackupTarget) => void;
};

/**
 * 書き出す対象の選択と、その件数 / 書き出せない理由。復元の対象トグルとは別の値で、
 * 書き出しは選んだ対象だけの ZIP になる (docs/backup.md)。見出しはページ側が持つ。
 */
export function BackupExportTargets({ targets, all, check, disabled = false, onToggle }: BackupExportTargetsProps) {
  const blocked = check ? backupExportBlockReason(check) : null;
  return (
    <div className="grid gap-1">
      {all.map((target) => {
        const count = backupExportCountOf(check, target);
        return (
          <label
            key={target}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-xs text-ink-strong",
              disabled && "opacity-60",
            )}
          >
            <input
              type="checkbox"
              className="accent-focus"
              checked={targets.includes(target)}
              disabled={disabled}
              onChange={() => onToggle(target)}
            />
            <span className="min-w-0 flex-1 truncate">{BACKUP_TARGET_LABELS[target]}</span>
            <span className="shrink-0 text-2xs text-ink-ghost">{count === undefined ? "—" : `${count} 件`}</span>
          </label>
        );
      })}
      {/* 何がどれだけ入るかを押す前に読めるようにする (0 件の対象は選んでも入らない) */}
      {check ? (
        <p className="text-2xs leading-relaxed break-words text-ink-muted">{backupExportSummary(check)}</p>
      ) : null}
      {blocked ? <p className="text-2xs leading-relaxed break-words text-warn">{blocked}</p> : null}
    </div>
  );
}
