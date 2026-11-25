import { cn } from "../../lib/cn";
import { ProviderIcon } from "../ProviderIcon";

export type ProviderRowProps = {
  /** ProviderIcon へ渡す id と名前（カスタムは定義の id、通常は provider の id） */
  id: string;
  name: string;
  /** 行の右端に出す短い状態。null は出さない */
  badge: { text: string; warn: boolean } | null;
  /** 名前の下に出す ID（カスタムは既定モデルも添える） */
  detail: string;
  active: boolean;
  onSelect: () => void;
};

/**
 * プロバイダー一覧の行。built-in とカスタムは同じ行の見た目を持ち、右端の状態と ID の行だけが違う。
 */
export function ProviderRow({ id, name, badge, detail, active, onSelect }: ProviderRowProps) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors",
        active ? "border-accent/40 bg-accent-wash" : "border-transparent hover:bg-hover",
      )}
    >
      <ProviderIcon provider={id} name={name} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{name}</span>
          {badge ? (
            <span className={cn("text-2xs whitespace-nowrap", badge.warn ? "text-warn" : "text-ink-muted")}>
              {badge.text}
            </span>
          ) : null}
        </span>
        <code className="truncate text-2xs text-ink-ghost">{detail}</code>
      </span>
    </button>
  );
}
