import { cn } from "../../lib/cn";
import { BACKUP_TARGET_LABELS } from "../../lib/backup";
import type { BackupTarget } from "../../types";

export type BackupExportTargetsProps = {
  /** 書き出す対象。既定は全部 ON */
  targets: readonly BackupTarget[];
  all: readonly BackupTarget[];
  disabled?: boolean;
  onToggle: (target: BackupTarget) => void;
};

/**
 * 書き出す対象の選択。復元の対象トグルとは別の値で、書き出しは選んだ対象だけの ZIP になる
 * (docs/backup.md)。見出しはページ側が持ち、ここは行だけを出す。
 */
export function BackupExportTargets({ targets, all, disabled = false, onToggle }: BackupExportTargetsProps) {
  return (
    <div className="grid gap-1">
      {all.map((target) => (
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
        </label>
      ))}
    </div>
  );
}
