import { compactionDividerLabel, compactionHistoryLabel, compactionSummaryHeading } from "../../lib/compaction";
import type { CompactionInfo } from "../../types";
import { DisclosureChevronIcon } from "../icons";

/**
 * 圧縮位置の区切り。過去の圧縮位置は context の組み替えで復元できないため、
 * 要約の一覧はこの 1 つの折りたたみにまとめる。
 */
export function CompactionDivider({ compactions, compact }: { compactions: CompactionInfo[]; compact: boolean }) {
  const latest = compactions[compactions.length - 1];
  if (!latest) return null;
  const historyLabel = compactionHistoryLabel(compactions.length);
  return (
    <details className="min-w-0 rounded-xl border border-line bg-soft/20 text-ink-muted">
      <summary
        className={[
          "tool-summary flex min-w-0 cursor-pointer items-center gap-2 outline-none transition-colors hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus",
          compact ? "px-2.5 py-2" : "px-3 py-2.5",
        ].join(" ")}
      >
        <DisclosureChevronIcon />
        <span className="min-w-0 flex-1 text-[11px] leading-relaxed">{compactionDividerLabel(latest)}</span>
        <span className="shrink-0 font-sans text-[9px] text-ink-faint">
          {compactions.length > 1 ? `${compactions.length}件` : "要約"}
        </span>
      </summary>
      <div className={["grid gap-3 border-t border-line", compact ? "px-2.5 py-2.5" : "px-3 py-3"].join(" ")}>
        {historyLabel ? <p className="m-0 text-[10px] text-ink-faint">{historyLabel}</p> : null}
        <ol className="m-0 grid list-none gap-3">
          {compactions.map((compaction, index) => (
            <li key={compaction.id} className="grid min-w-0 gap-1">
              <span className="font-sans text-[9px] uppercase tracking-wide text-ink-faint">
                {compactionSummaryHeading(compaction, index)}
              </span>
              <p className="m-0 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-soft">
                {compaction.summary}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
