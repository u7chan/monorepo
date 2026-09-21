import { cn } from "../../lib/cn";

/** エージェント / Model / Effort の select で同じ見た目を共有する (片方だけ変わると行が揃わない) */

export const fieldLabelClass = (compact: boolean): string =>
  cn("flex min-w-0 items-center text-2xs text-ink-faint", compact ? "gap-2" : "gap-1.5");

export const fieldNameClass = (compact: boolean): string =>
  cn(compact ? "w-12 shrink-0 tracking-wide uppercase" : "shrink-0 tracking-wide uppercase");
