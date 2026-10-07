import { cn } from "../lib/cn";

/**
 * 有効 / 無効のトグルスイッチ。文字だけでは押せると分からないので、トラックとつまみの形で示す。
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
        "switch",
        size === "md" ? "min-h-7.5 gap-2 text-1xs" : "min-h-5.5 gap-1.5 text-3xs",
        checked ? "text-accent-text" : "text-ink-faint",
      )}
    >
      <span
        className={cn(
          "switch-track",
          size === "sm" && "switch-track-sm",
          checked ? "switch-track-on" : "switch-track-off",
        )}
        aria-hidden
      >
        <span className="switch-knob" />
      </span>
      {label}
    </button>
  );
}
