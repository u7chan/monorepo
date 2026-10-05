import type { ThemeId } from "../../theme/themes";

/**
 * テーマの縮小プレビュー。色はテーマプリセットの CSS 変数（`--c-*`）を参照し、
 * この要素の `data-theme` がプリセット選択の入口になる（プリセットは `html` に限らず
 * `[data-theme]` に当たる）。テーマごとの色をここへ書くと registry と二重管理になる。
 * 中身は装飾なので、読み上げはカード側のラベルに任せる。
 */
export function ThemePreview({ themeId }: { themeId: ThemeId }) {
  // text-ink は継承色をプレビュー自身のテーマへ向け直すため。`.tok-*` を持たない素の文字
  // (コード行の `x` など) は画面側テーマの body 色を継承し、自分の背景に対してコントラストが崩れる
  // (テーマの組み合わせ次第で 2:1 を切る)。
  return (
    <div
      data-theme={themeId}
      aria-hidden="true"
      className="overflow-hidden rounded-md border border-line bg-base text-ink"
    >
      {/* トップバー */}
      <div className="flex h-4 items-center gap-1 border-b border-line bg-panel px-1.5">
        <span className="size-1.5 rounded-full bg-accent" />
        <span className="h-1 w-8 rounded-full bg-line-strong" />
        <span className="ml-auto h-1 w-4 rounded-full bg-line-strong" />
      </div>
      <div className="flex h-16">
        {/* 左バー */}
        <div className="flex w-9 shrink-0 flex-col gap-1 border-r border-line bg-panel p-1.5">
          <span className="flex h-2.5 items-center rounded-sm border-l-2 border-accent bg-accent-wash pl-0.5">
            <span className="h-1 w-3 rounded-full bg-ink-ghost" />
          </span>
          <span className="h-1 w-5 rounded-full bg-line-strong" />
          <span className="h-1 w-4 rounded-full bg-line-strong" />
          <span className="h-1 w-6 rounded-full bg-line-strong" />
        </div>
        {/* 会話 */}
        <div className="flex min-w-0 flex-1 flex-col justify-end gap-1.5 p-2">
          <span className="ml-auto h-3 w-16 rounded-lg rounded-tr-sm bg-accent-bright" />
          <span className="h-1 w-12 rounded-full bg-ink-ghost" />
          <span className="w-fit rounded border border-line bg-panel px-1 py-0.5 font-mono text-3xs">
            <span className="tok-key">const</span> x <span className="tok-op">=</span>{" "}
            <span className="tok-num">1</span>
          </span>
        </div>
      </div>
      {/* 入力欄 */}
      <div className="flex h-5 items-center gap-1 border-t border-line bg-panel px-1.5">
        <span className="h-2.5 min-w-0 flex-1 rounded-full border border-line bg-raised" />
        <span className="size-2.5 rounded-full bg-accent" />
      </div>
    </div>
  );
}
