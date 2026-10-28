import { cn } from "../../lib/cn";

/**
 * スキル / ツールの切替行。**行全体が 1 つの `role="switch"` ボタン**で、タップ領域は行そのもの。
 * 装飾のトラックは `aria-hidden` にして読み上げ名を行の名前に閉じる (チェックボックス + label の
 * 2 要素に分けると、行のどこを押せば切り替わるかが見た目で決まらない)。
 */
export function SwitchRow({
  name,
  description,
  badge,
  hint,
  checked,
  monoName = false,
  disabled = false,
  onToggle,
  toggleLabel,
}: {
  name: string;
  description: string;
  /** 名前の右に出す補足 (版 / 「自動起動なし」など) */
  badge?: string;
  /** 説明の下に出す補足 (外したときの影響 / 使えない理由) */
  hint?: string;
  checked: boolean;
  /** ツール ID のように識別子を等幅で出す */
  monoName?: boolean;
  disabled?: boolean;
  onToggle: (checked: boolean) => void;
  /** 読み上げ名。未指定なら「<name> を使う」 */
  toggleLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={toggleLabel ?? `${name} を使う`}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
      className={cn(
        "flex min-h-11 w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
        "hover:bg-hover disabled:cursor-not-allowed disabled:opacity-55 wide:min-h-12",
        checked ? "text-ink" : "text-ink-muted",
      )}
    >
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={cn("min-w-0 truncate text-xs", monoName && "font-mono")}>{name}</span>
          {badge ? <span className="shrink-0 text-2xs leading-4 text-ink-ghost">{badge}</span> : null}
        </span>
        {/* 説明の全文は「スキル」ページにあるので、ここは 1 行に切って title へ逃がす (行の高さを増やさない) */}
        <span className="block truncate text-2xs leading-4 text-ink-muted" title={description}>
          {description}
        </span>
        {hint ? <span className="block text-2xs leading-4 text-ink-faint">{hint}</span> : null}
      </span>
      {/* 見た目のトラック。押せるのは行全体なので、装飾はキーボードと読み上げの対象から外す */}
      <span aria-hidden className="switch mt-0.5 shrink-0">
        <span className={cn("switch-track", checked ? "switch-track-on" : "switch-track-off")}>
          <span className="switch-knob" />
        </span>
      </span>
    </button>
  );
}
