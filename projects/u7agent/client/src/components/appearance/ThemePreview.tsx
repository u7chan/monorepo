import type { ThemeId } from "../../theme/themes";

/**
 * テーマの縮小プレビュー。色はテーマプリセットの CSS 変数（`--c-*`）を参照し、
 * この要素の `data-theme` がプリセット選択の入口になる（プリセットは `html` に限らず
 * `[data-theme]` に当たる）。テーマごとの色をここへ書くと registry と二重管理になる。
 * 中身は装飾なので、読み上げはカード側のラベルに任せる。
 */
export function ThemePreview({ themeId }: { themeId: ThemeId }) {
  // text-ink は継承色をプレビュー自身のテーマへ向け直すため。`.tok-*` を持たない素の文字
  // (コード行の `theme` など) は画面側テーマの body 色を継承し、自分の背景に対してコントラストが崩れる
  // (テーマの組み合わせ次第で 2:1 を切る)。
  return (
    <div
      data-theme={themeId}
      aria-hidden="true"
      className="overflow-hidden rounded-md border border-line bg-base text-ink"
    >
      {/* トップバー */}
      <div className="flex h-5 items-center gap-1.5 border-b border-line bg-panel px-1.5">
        <span className="size-1.5 rounded-full bg-accent" />
        <span className="text-3xs text-ink-faint">u7agent</span>
        <span className="ml-auto h-1.5 w-9 rounded-full bg-soft" />
      </div>
      <div className="flex">
        {/* 左バー: 状態ドットと選択行で、テーマの差し色と面の重なりを見せる */}
        <div className="flex w-21 shrink-0 flex-col gap-0.5 border-r border-line bg-panel px-1 py-1.5">
          <span className="px-1 text-3xs tracking-label text-ink-ghost uppercase">Sessions</span>
          <span className="flex items-center gap-1 rounded-sm bg-accent-wash px-1 py-0.5 text-3xs text-ink">
            <span className="size-1 rounded-full bg-accent" />
            テーマ追加
          </span>
          <span className="flex items-center gap-1 px-1 py-0.5 text-3xs text-ink-soft">
            <span className="size-1 rounded-full bg-warn" />
            依存更新
          </span>
          <span className="flex items-center gap-1 px-1 py-0.5 text-3xs text-ink-soft">
            <span className="size-1 rounded-full bg-ok" />
            ビルド修正
          </span>
          <span className="flex items-center gap-1 px-1 py-0.5 text-3xs text-ink-soft">
            <span className="size-1 rounded-full bg-danger" />
            落ちたテスト
          </span>
        </div>
        {/* 会話: 吹き出し・本文・コード・状態ラベル・入力欄 */}
        <div className="flex min-w-0 flex-1 flex-col gap-1 px-1.5 py-1.5">
          <span className="ml-auto rounded-md rounded-br-sm bg-accent-bright px-1.5 py-0.5 text-3xs text-on-accent">
            配色を見てます
          </span>
          <span className="text-3xs text-ink-soft">テーマを 1 つ足しました。</span>
          <span className="grid gap-0 rounded border border-line bg-soft px-1 py-0.5 font-mono text-3xs leading-relaxed">
            <span>
              <span className="tok-com">// 色トークンを差し替える</span>
            </span>
            <span>
              <span className="tok-key">const</span> theme <span className="tok-op">=</span>{" "}
              <span className="tok-str">{`"${themeId}"`}</span>
              <span className="tok-op">;</span>
            </span>
          </span>
          <span className="flex flex-wrap gap-1">
            <span className="rounded-sm bg-accent-wash px-1 text-3xs text-accent-text">実行中</span>
            <span className="rounded-sm bg-ok/10 px-1 text-3xs text-ok-text">完了</span>
            <span className="rounded-sm bg-warn/10 px-1 text-3xs text-warn-text">回答待ち</span>
            <span className="rounded-sm bg-danger/10 px-1 text-3xs text-danger-text">失敗</span>
          </span>
          <span className="flex items-center rounded border border-line bg-raised px-1.5 py-0.5 text-3xs text-ink-ghost">
            メッセージを入力…
            <span className="ml-auto size-2 rounded-sm bg-accent" />
          </span>
        </div>
      </div>
      {/* 配色の帯: どのテーマかを見分ける手掛かりとして面と差し色を並べる */}
      <div className="flex h-1.5 border-t border-line">
        <span className="flex-1 bg-base" />
        <span className="flex-1 bg-panel" />
        <span className="flex-1 bg-raised" />
        <span className="flex-1 bg-soft" />
        <span className="flex-1 bg-accent" />
        <span className="flex-1 bg-accent-bright" />
        <span className="flex-1 bg-ok" />
        <span className="flex-1 bg-warn" />
        <span className="flex-1 bg-danger" />
        <span className="flex-1 bg-ink-strong" />
      </div>
    </div>
  );
}
