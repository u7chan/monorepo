import type { ProviderBadge } from "../../lib/modelSettings";
import { MetaChip } from "./MetaChip";

/** provider の認証状態バッジ。設定 → モデルの両タブで同じ見た目を使う (実体は MetaChip) */
export function ProviderBadgeTag({ badge }: { badge: ProviderBadge }) {
  return <MetaChip tone={badge.tone}>{badge.label}</MetaChip>;
}
