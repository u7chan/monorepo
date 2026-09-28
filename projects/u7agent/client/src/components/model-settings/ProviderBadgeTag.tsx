import { cn } from "../../lib/cn";
import type { ProviderBadge, ProviderBadgeTone } from "../../lib/modelSettings";

const BADGE_TONE: Record<ProviderBadgeTone, string> = {
  ok: "border-ok/40 text-ok",
  muted: "border-line text-ink-muted",
  warn: "border-warn/40 text-warn",
};

/** provider の認証状態バッジ。設定 → モデルの両タブで同じ見た目を使う */
export function ProviderBadgeTag({ badge }: { badge: ProviderBadge }) {
  return (
    <span className={cn("rounded border px-1.5 py-0.5 text-2xs whitespace-nowrap", BADGE_TONE[badge.tone])}>
      {badge.label}
    </span>
  );
}
