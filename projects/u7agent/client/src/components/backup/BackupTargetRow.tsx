import { cn } from "../../lib/cn";
import type { BackupTarget } from "../../lib/backupTargets";

export type BackupTargetRowProps = {
  target: BackupTarget;
  /** 件数・現在値など、対象の定義に持たせられない補足 */
  details: string[];
  checked: boolean;
  onToggle: (next: boolean) => void;
};

/**
 * エクスポートする対象を選ぶ行。行全体がラベルなので、チェックボックス以外を押しても切り替わる。
 * 準備中の対象はチェックできず、行を押しても変わらない (取り込めない対象を選べるように見せない)。
 */
export function BackupTargetRow({ target, details, checked, onToggle }: BackupTargetRowProps) {
  return (
    <label className={cn("flex items-start gap-2.5 px-3 py-2.5", target.ready ? "cursor-pointer" : "cursor-default")}>
      <input
        type="checkbox"
        className="mt-0.5 accent-focus"
        checked={checked}
        disabled={!target.ready}
        onChange={(event) => onToggle(event.currentTarget.checked)}
      />
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-xs leading-4 text-ink">{target.label}</span>
          {target.ready ? null : <PendingLabel />}
        </span>
        <span className="text-2xs leading-4 text-ink-ghost">
          {[target.description, ...details, target.store].join(" · ")}
        </span>
      </span>
    </label>
  );
}

/** 押せない理由をラベルで示す (チェックボックスだけでは無効の理由が読めない) */
function PendingLabel() {
  return <span className="shrink-0 rounded border border-line px-1 text-3xs leading-4 text-ink-ghost">準備中</span>;
}
