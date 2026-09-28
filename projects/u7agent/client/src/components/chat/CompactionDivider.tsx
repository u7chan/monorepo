import { cn } from "../../lib/cn";
import { compactionDividerLabel, compactionHistoryLabel, compactionSummaryHeading } from "../../lib/compaction";
import type { CompactionInfo } from "../../types";
import { DisclosureChevronIcon } from "../icons";

/**
 * 圧縮位置の区切り。全履歴では圧縮イベントごとに 1 つ出す (要約はその場で読める)。
 * 旧 payload (全履歴 API 無し) では位置を持つ最新の区切りに全要約をまとめる。
 */
export function CompactionDivider({
  compactions,
  startIndex = 0,
  compact,
}: {
  compactions: CompactionInfo[];
  /** compactions[0] の全体順。履歴の区切りで「N回目」を通し番号にする */
  startIndex?: number;
  compact: boolean;
}) {
  const latest = compactions[compactions.length - 1];
  if (!latest) return null;
  const historyLabel = compactionHistoryLabel(compactions.length);
  return (
    <details className="min-w-0 rounded-xl border border-line bg-soft/20 text-ink-muted">
      <summary
        className={cn(
          "disclosure-summary flex min-w-0 cursor-pointer items-center gap-2 transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset",
          compact ? "px-2.5 py-2" : "px-3 py-2.5",
        )}
      >
        <DisclosureChevronIcon />
        <span className="min-w-0 flex-1 text-1xs leading-relaxed">{compactionDividerLabel(latest)}</span>
        <span className="shrink-0 font-sans text-3xs text-ink-faint">
          {compactions.length > 1 ? `${compactions.length}件` : "要約"}
        </span>
      </summary>
      <div className={cn("grid gap-3 border-t border-line", compact ? "px-2.5 py-2.5" : "px-3 py-3")}>
        {historyLabel ? <p className="m-0 text-2xs text-ink-faint">{historyLabel}</p> : null}
        <ol className="m-0 grid list-none gap-3">
          {compactions.map((compaction, index) => (
            <li key={compaction.id} className="grid min-w-0 gap-1">
              <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">
                {compactionSummaryHeading(compaction, startIndex + index)}
              </span>
              <p className="m-0 text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-soft">
                {compaction.summary}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
