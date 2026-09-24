import { cn } from "../../lib/cn";

/** 有効 / 無効のスイッチ。文字だけでは状態が読み取りにくいので、丸の印と塗りでも分ける */
export function ToggleSwitch({
  checked,
  label,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex min-h-7.5 items-center gap-1.5 rounded-full border px-2.5 text-1xs transition-colors disabled:cursor-not-allowed disabled:opacity-55",
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
