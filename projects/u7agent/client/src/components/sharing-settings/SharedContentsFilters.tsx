import { cn } from "../../lib/cn";
import { SHARED_CONTENT_FILTERS, type SharedContentsFilter } from "../../lib/sharedContents";

export type SharedContentsFiltersProps = {
  filter: SharedContentsFilter;
  counts: Record<SharedContentsFilter, number>;
  /** 各フィルタのうち、公開が完了していない（要更新）件数。0 のときは添えない */
  undeployedCounts: Record<SharedContentsFilter, number>;
  onSelect: (filter: SharedContentsFilter) => void;
};

/** 状態フィルタ。件数は絞り込みの外側の全件から数え、どの面に何件あるかを常に見せる */
export function SharedContentsFilters({ filter, counts, undeployedCounts, onSelect }: SharedContentsFiltersProps) {
  return (
    <div role="group" aria-label="共有コンテンツの状態" className="flex min-w-0 flex-wrap items-center gap-1">
      {SHARED_CONTENT_FILTERS.map((item) => {
        const active = item.key === filter;
        const undeployed = undeployedCounts[item.key];
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(item.key)}
            className={cn(
              "inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-2xs transition-colors",
              active
                ? "border-accent/45 bg-accent-wash font-semibold text-accent-text"
                : "border-transparent text-ink-muted hover:bg-hover hover:text-ink",
            )}
          >
            {item.label}
            <span className={cn("tabular-nums", active ? "text-accent-text/75" : "text-ink-faint")}>
              {counts[item.key]}
            </span>
            {/* 絞り込みは status のままなので、公開が止まっている行があることを件数の横で示す */}
            {undeployed > 0 ? <span className="text-warn-text tabular-nums">要更新 {undeployed}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
