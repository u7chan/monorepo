import type { ReactNode } from "react";
import { ArrowLeftIcon, MenuIcon } from "./icons";

export type SettingsPageProps = {
  onBack: () => void;
  compact?: boolean;
  onOpenNav?: () => void;
};

export type SettingsPageLayoutProps = SettingsPageProps & {
  eyebrow: string;
  title: string;
  caption?: ReactNode;
  actions?: ReactNode;
  /** aria-live で読み上げる */
  note?: { text: string; error: boolean };
  children: ReactNode;
};

/**
 * 設定ページの共通の外装。元の full screen dialog をやめてメイン列に置くため、
 * ヘッダ + 本文 (+ ノート) を viewport の高さいっぱいに組む。
 */
export function SettingsPageLayout({
  eyebrow,
  title,
  caption,
  actions,
  note,
  compact = false,
  onBack,
  onOpenNav,
  children,
}: SettingsPageLayoutProps) {
  return (
    // minmax(0,1fr) で列幅を viewport に固定する (auto だと nowrap のパス文字列に引き伸ばされる)
    <section className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
      <header
        className={[
          "flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-line",
          compact ? "px-4 pt-3.5 pb-3" : "px-5 pt-4 pb-3.5",
        ].join(" ")}
      >
        {/* タイトル列に最小幅を持たせ、狭い viewport では操作行の方を折り返す (文字が数文字幅まで潰れるのを防ぐ) */}
        <div className="flex min-w-0 flex-1 basis-[240px] items-center gap-2.5">
          {/* compact ではヘッダが CompactBar の代わりになる。無いと設定ページ間を移動できない */}
          {compact && onOpenNav ? (
            <button
              type="button"
              onClick={onOpenNav}
              aria-label="ナビゲーションを開く"
              className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
            >
              <MenuIcon />
            </button>
          ) : null}
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-ghost">{eyebrow}</div>
            <h2 className="text-lg font-semibold text-ink-strong">{title}</h2>
            {caption ? <div className="min-w-0">{caption}</div> : null}
          </div>
        </div>
        {/* 操作も戻り導線も無いページ (desktop の「外観」) では行ごと出さない (空の div を残さない) */}
        {actions || compact ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {actions}
            {/* desktop はサイドバーに同じ「アプリに戻る」が並ぶので出さない。compact はサイドバーが drawer の中なので、1 タップで戻れる導線をここに残す */}
            {compact ? (
              <button type="button" onClick={onBack} className="btn-quiet">
                <ArrowLeftIcon />
                アプリに戻る
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {children}

      {/* ノートが無いページでは行ごと出さない (空の帯を残さない) */}
      {note ? (
        <div
          aria-live="polite"
          className={[
            "border-t border-line px-5 py-2.5 text-[11px] break-words",
            note.error ? "text-danger-text" : "text-ink-muted",
          ].join(" ")}
        >
          {note.text}
        </div>
      ) : null}
    </section>
  );
}
