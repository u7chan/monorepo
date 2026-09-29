import { cn } from "../lib/cn";
import { providerIconKey, providerMonogram, PROVIDER_ICON_PATHS } from "../lib/providerIcon";

/** 置く場所ごとの寸法。呼び出し側は位置だけを渡す */
export type ProviderIconVariant = "list" | "heading";

/** 一覧・モデル候補の行は名前の 2 行分、詳細の見出しは見出しの高さに合わせる */
const VARIANT_CLASS: Record<ProviderIconVariant, string> = {
  list: cn("size-7 rounded-md"),
  heading: cn("size-8 rounded-lg"),
};

/** タイル (28 / 32px) に対して余白が残る大きさ。線の太いロゴでも潰れない */
const GLYPH_CLASS: Record<ProviderIconVariant, string> = {
  list: cn("size-4"),
  heading: cn("size-5"),
};

/**
 * provider のロゴ。ロゴが無い provider（カスタム / SDK の新顔）は頭文字のタイルにして、
 * 一覧でも名前の横で見分けられるようにする。読み上げ名は隣のテキストが持つため装飾に徹する。
 */
export function ProviderIcon({
  provider,
  name,
  variant = "list",
}: {
  provider: string;
  /** ロゴが無い provider の頭文字に使う表示名 */
  name: string;
  variant?: ProviderIconVariant;
}) {
  const key = providerIconKey(provider);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center border border-line bg-base text-ink-soft",
        VARIANT_CLASS[variant],
      )}
    >
      {key === null ? (
        <span className="text-1xs font-semibold">{providerMonogram(name, provider)}</span>
      ) : (
        <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={GLYPH_CLASS[variant]}>
          {PROVIDER_ICON_PATHS[key].map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      )}
    </span>
  );
}
