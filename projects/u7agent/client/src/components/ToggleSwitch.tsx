import { cn } from "../lib/cn";

/**
 * 有効 / 無効のスイッチ。文字だけでは状態が読み取りにくいので、丸の印と塗りでも分ける。
 * `size="sm"` はプレビューのパス行のように高さを詰めた行で使う (ソース / プレビューの切替と同じ高さ)。
 */
export function ToggleSwitch({
  checked,
  label,
  disabled = false,
  size = "md",
  title,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  /** `sm` はパス行のように高さを詰めた行で使う (行の他の切替と高さを揃える) */
  size?: "md" | "sm";
  /** ラベルだけでは効果が読み取れないときのポインタ向け補足 */
  title?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-55",
        size === "md" ? "min-h-7.5 gap-1.5 px-2.5 text-1xs" : "min-h-5.5 gap-1 px-2 text-3xs",
        checked
          ? "border-accent/50 bg-accent-wash text-accent-text"
          : "border-line text-ink-soft hover:border-accent/50 hover:text-accent-text",
      )}
    >
      <span className={cn("dot", checked ? "dot-accent" : "dot-idle")} aria-hidden />
      {label}
    </button>
  );
}
