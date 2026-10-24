import { cn } from "../../lib/cn";
import { SHARED_CONTENT_FILTERS, type SharedContentsFilter } from "../../lib/sharedContents";

export type SharedContentsFiltersProps = {
  filter: SharedContentsFilter;
  counts: Record<SharedContentsFilter, number>;
  onSelect: (filter: SharedContentsFilter) => void;
};

/** 状態フィルタ。件数は絞り込みの外側の全件から数え、どの面に何件あるかを常に見せる */
export function SharedContentsFilters({ filter, counts, onSelect }: SharedContentsFiltersProps) {
  return (
    <div role="group" aria-label="共有コンテンツの状態" className="flex min-w-0 flex-wrap items-center gap-1">
      {SHARED_CONTENT_FILTERS.map((item) => {
        const active = item.key === filter;
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
          </button>
        );
      })}
    </div>
  );
}
