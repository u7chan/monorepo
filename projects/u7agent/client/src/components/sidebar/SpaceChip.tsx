import { cn } from "../../lib/cn";

/**
 * 会話一覧の見出しに出す現在の会話スペース。`accent` は追加スペース (会話専用) で真にし、
 * 既定スペースでは控えめなトーンで出す。押すと 設定 → 会話スペース へ移る (その場では切り替えない)。
 */
export function SpaceChip({ name, accent, onOpen }: { name: string; accent: boolean; onOpen: () => void }) {
  const label = `会話スペース: ${name}`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onOpen}
      className={cn(
        "inline-flex min-h-6 max-w-32 min-w-0 items-center rounded-full border px-2 text-2xs font-semibold transition-colors outline-none focus-visible:ring-1 focus-visible:ring-focus",
        accent
          ? "border-accent/45 bg-accent-wash text-accent-text hover:border-accent/70"
          : "border-line-strong bg-soft text-ink-muted hover:border-accent/50 hover:text-accent-text",
      )}
    >
      <span className="min-w-0 truncate">{name}</span>
    </button>
  );
}
