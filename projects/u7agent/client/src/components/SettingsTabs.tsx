import { useEffect, useRef } from "react";
import { cn } from "../lib/cn";

/**
 * 設定ページのタブ行 (`role="tablist"`)。表示の正は URL で、選択中の値と切替の要求だけを受け取る。
 * singleColumn では横スクロールする行の選択中タブを可視域へ入れる。
 * `dense` は 248px の一覧列のように、タブが入り切らない狭い面に置くときの詰めた余白。
 * `ariaLabel` と `mark` は未指定なら今までどおり描く（読み上げ名を変える画面と、警告の印を出す画面だけが使う）。
 */
export function SettingsTabs<T extends string>({
  items,
  active,
  onSelect,
  ariaLabel,
  singleColumn = false,
  dense = false,
}: {
  items: readonly { subsection: T; label: string; ariaLabel?: string; mark?: boolean }[];
  active: T;
  onSelect?: (subsection: T) => void;
  ariaLabel: string;
  singleColumn?: boolean;
  /** 並べて見せる狭い列に置くときは true。余白を詰めた上で、選択中タブを可視域へ入れる */
  dense?: boolean;
}) {
  const compact = singleColumn || dense;
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (compact) activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [compact, active]);
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("flex min-w-0 shrink-0 gap-1 overflow-x-auto border-b border-line", compact ? "px-2" : "px-4")}
    >
      {items.map((item) => (
        <button
          key={item.subsection}
          ref={active === item.subsection ? activeRef : undefined}
          type="button"
          role="tab"
          aria-selected={active === item.subsection}
          aria-label={item.ariaLabel}
          onClick={() => onSelect?.(item.subsection)}
          className={cn(
            "tab-item shrink-0 whitespace-nowrap",
            item.mark && "flex items-center gap-1.5",
            compact && "px-1.5",
            active === item.subsection && "tab-item-active",
          )}
        >
          {item.label}
          {item.mark ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warn" /> : null}
        </button>
      ))}
    </div>
  );
}
