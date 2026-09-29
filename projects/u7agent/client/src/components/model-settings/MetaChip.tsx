import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** チップの色。provider の認証バッジ (`ProviderBadge`) と同じ 3 種を使う */
export type MetaChipTone = "ok" | "muted" | "warn";

const TONE_CLASS: Record<MetaChipTone, string> = {
  ok: "border-ok/40 text-ok",
  muted: "border-line text-ink-muted",
  warn: "border-warn/40 text-warn",
};

/**
 * 設定 → モデル の 1 行メタ情報（認証状態・利用可能数・キー最終保存・最終使用・カタログの出どころ）。
 * 認証バッジ (`ProviderBadgeTag`) と同じ寸法・余白のチップに揃え、日時や件数を行として読ませる。
 * 既定は折り返さない (1 つの値を 1 つのチップとして扱い、行の折り返しは親の flex-wrap に任せる)。
 * 文として長くなるメタ（カタログの出どころなど）だけ `wrap` を使う。このときは
 * `inline-block max-w-full` で 1 つの箱のまま中で折り返す（inline のままだと行ごとに
 * 枠線が分断される）。`<p>` の中に置く場合は段落のセマンティクスを残すため、呼び側で包む。
 */
export function MetaChip({
  tone = "muted",
  wrap = false,
  children,
}: {
  tone?: MetaChipTone;
  wrap?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0.5 text-2xs",
        wrap ? "inline-block max-w-full leading-relaxed whitespace-normal" : "whitespace-nowrap",
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}
