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
 * 設定の 1 行メタ情報。認証バッジと同じ寸法・余白に揃え、既定は折り返さない (折り返しは親に任せる)。
 * 文として長いメタだけ `wrap` を使い、`inline-block max-w-full` で 1 つの箱の中で折り返す。
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
