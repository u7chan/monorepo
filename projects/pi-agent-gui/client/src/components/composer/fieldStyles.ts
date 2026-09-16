/** エージェント / Model / Effort の select で同じ見た目を共有する (片方だけ変わると行が揃わない) */

export const fieldLabelClass = (compact: boolean): string =>
  ["flex min-w-0 items-center text-2xs text-ink-faint", compact ? "gap-2" : "gap-1.5"].join(" ");

export const fieldNameClass = (compact: boolean): string =>
  compact ? "w-12 shrink-0 uppercase tracking-wide" : "shrink-0 uppercase tracking-wide";
