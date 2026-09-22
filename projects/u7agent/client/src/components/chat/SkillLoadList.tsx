import { cn } from "../../lib/cn";
import { formatReadLineRange, skillLoadSummary } from "../../lib/skillLoad";
import type { SkillLoad } from "../../types";
import { DisclosureChevronIcon } from "../icons";

// 位相ラベルと同じ固定幅。状態で行の右端が動かないようにする (ToolHistory と同じ寸法)
const PHASE_LABEL_CLASS = cn("w-[3.25em] shrink-0 text-right font-sans text-3xs whitespace-nowrap");

/**
 * 履歴の吹き出しに出すスキル読み込み行。既定で閉じて `[skill] <name>[:start-end]` だけを見せ、
 * 展開で解決後のパスと行範囲を確認できる (本文の展開は非ゴール)。
 */
export function SkillLoadList({ loads, compact }: { loads: SkillLoad[]; compact: boolean }) {
  if (loads.length === 0) return null;
  return (
    <ul className={cn("m-0 grid list-none gap-1.5 font-mono text-2xs text-ink-muted", compact ? "mb-1.5" : "mb-2.5")}>
      {loads.map((load) => {
        const range = formatReadLineRange(load.offset, load.limit);
        return (
          <li key={load.id} className="min-w-0">
            <details
              className={cn(
                "rounded-lg border bg-soft/20 transition-colors",
                load.isError ? "border-danger/50" : "border-line/70",
              )}
            >
              <summary className="tool-summary flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
                <DisclosureChevronIcon />
                <span className="min-w-0 flex-1 truncate">{skillLoadSummary(load)}</span>
                {load.isError ? <span className={cn(PHASE_LABEL_CLASS, "text-danger-text")}>エラー</span> : null}
              </summary>
              <div
                className={cn(
                  "grid gap-1.5 border-t border-line/70 py-2 pr-2 text-ink-muted",
                  compact ? "pl-3" : "pl-6",
                )}
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">パス</span>
                  <code className="break-words whitespace-pre-wrap">{load.path}</code>
                </div>
                {range ? (
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">行範囲</span>
                    <code>{range.slice(1)}</code>
                  </div>
                ) : null}
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
