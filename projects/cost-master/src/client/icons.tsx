import type { JSX } from "preact";
import type { CostKind } from "../shared/contract";

/** カテゴリのセグメントと行に使う線画。名前は `CostKind` と、両方をまとめる「すべて」 */
export type KindIconName = "all" | CostKind;

const GLYPHS: Record<KindIconName, JSX.Element> = {
  all: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h6.5" />,
  image: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="2" />
      <circle cx="5.9" cy="6.7" r="1" fill="currentColor" stroke="none" />
      <path d="M3.2 11.6 6.9 6.6a1 1 0 0 1 1.6 0l3.5 5" />
    </>
  ),
  speech: <path d="M3.6 7.2v1.6M6.2 5.2v5.6M8.8 3.4v9.2M11.4 5.2v5.6M14 7.2v1.6" />,
};

/**
 * 色は文字から継承する。カテゴリ分けに状態色（緑 / オレンジ）を使わないため、塗りと色を持たせない。
 * 意味は必ず隣のラベルが持つので、読み上げには出さない。
 */
export function KindIcon({ name, size = 16 }: { name: KindIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}
