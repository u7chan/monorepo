import { cn } from "../lib/cn";

/**
 * 2 値以上の表示切替 (ソース / プレビュー など)。選択は呼び出し側が持ち、ここは押下だけを返す。
 * 既定はファイルプレビューの切替と同じ小ささで、設定の値を選ぶ面は `comfortable` にする (タップ領域)。
 */
export function SegmentedControl<T extends string | number>({
  items,
  value,
  onChange,
  ariaLabel,
  size = "compact",
}: {
  items: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "compact" | "comfortable";
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line p-0.5"
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            "rounded-md transition-colors",
            size === "comfortable" ? "min-h-9 flex-1 px-3 text-xs singleColumn:min-h-11" : "px-2 py-0.5 text-3xs",
            value === item.value ? "bg-accent-wash text-accent-text" : "text-ink-soft hover:bg-hover hover:text-ink",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
