import { useEffect, useRef } from "react";
import { cn } from "../lib/cn";

/**
 * 設定ページのタブ行 (`role="tablist"`)。表示の正は URL で、選択中の値と切替の要求だけを受け取る。
 * singleColumn では横スクロールする行の選択中タブを可視域へ入れる。
 */
export function SettingsTabs<T extends string>({
  items,
  active,
  onSelect,
  ariaLabel,
  singleColumn = false,
}: {
  items: readonly { subsection: T; label: string }[];
  active: T;
  onSelect?: (subsection: T) => void;
  ariaLabel: string;
  singleColumn?: boolean;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (singleColumn) activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [singleColumn, active]);
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("flex min-w-0 shrink-0 gap-1 overflow-x-auto border-b border-line", singleColumn ? "px-2" : "px-4")}
    >
      {items.map((item) => (
        <button
          key={item.subsection}
          ref={active === item.subsection ? activeRef : undefined}
          type="button"
          role="tab"
          aria-selected={active === item.subsection}
          onClick={() => onSelect?.(item.subsection)}
          className={cn(
            "tab-item shrink-0 whitespace-nowrap",
            singleColumn && "px-1.5",
            active === item.subsection && "tab-item-active",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
