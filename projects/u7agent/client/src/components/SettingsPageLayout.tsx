import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { ArrowLeftIcon, MenuIcon } from "./icons";

export type SettingsPageProps = {
  onBack: () => void;
  singleColumn?: boolean;
  onOpenNav?: () => void;
};

export type SettingsPageLayoutProps = SettingsPageProps & {
  eyebrow: string;
  title: string;
  caption?: ReactNode;
  /** 本文の上に置くタブ行 (role="tablist")。無いページでは行ごと出さない */
  tabs?: ReactNode;
  /** タブ行と本文の間に置く面ツールバー (TabToolbar)。操作を持たない面では行ごと出さない */
  toolbar?: ReactNode;
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
  tabs,
  toolbar,
  note,
  singleColumn = false,
  onBack,
  onOpenNav,
  children,
}: SettingsPageLayoutProps) {
  return (
    // minmax(0,1fr) で列幅を viewport に固定する (auto だと nowrap のパス文字列に引き伸ばされる)
    <section
      className={cn(
        "grid h-full min-h-0 grid-cols-1 overflow-hidden",
        tabs && toolbar
          ? "grid-rows-[auto_auto_auto_minmax(0,1fr)_auto]"
          : tabs || toolbar
            ? "grid-rows-[auto_auto_minmax(0,1fr)_auto]"
            : "grid-rows-[auto_minmax(0,1fr)_auto]",
      )}
    >
      <header
        className={cn(
          "flex min-w-0 items-center gap-2.5 border-b border-line",
          singleColumn ? "px-4 pt-3.5 pb-3" : "px-5 pt-4 pb-3.5",
        )}
      >
        {/* desktop はサイドバーに同じ「アプリに戻る」が並ぶので出さない。singleColumn はサイドバーが drawer の中なので、
            1 タップで戻れる導線を左端に出す */}
        {singleColumn ? (
          <button type="button" onClick={onBack} className="btn-quiet min-h-11 shrink-0">
            <ArrowLeftIcon />
            アプリに戻る
          </button>
        ) : null}
        {/* singleColumn は SingleColumnBar の代わりに、狭い desktop は左バーが overlay になるため、
            どちらもここが設定ページ間を移るための nav の導線になる */}
        {onOpenNav ? (
          <button
            type="button"
            onClick={onOpenNav}
            aria-label="ナビゲーションを開く"
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
          >
            <MenuIcon />
          </button>
        ) : null}
        {/* 縮むのはこの列だけにして、タイトル / 説明は折り返して読ませる。左の操作を縮めると、
            ラベルが縦に数文字へ潰れる */}
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">{eyebrow}</div>
          <h2 className="text-lg font-semibold text-ink-strong">{title}</h2>
          {caption ? <div className="min-w-0">{caption}</div> : null}
        </div>
      </header>

      {tabs}

      {toolbar}

      {children}

      {/* ノートが無いページでは行ごと出さない (空の帯を残さない) */}
      {note ? (
        <div
          aria-live="polite"
          className={cn(
            "border-t border-line px-5 py-2.5 text-1xs break-words",
            note.error ? "text-danger-text" : "text-ink-muted",
          )}
        >
          {note.text}
        </div>
      ) : null}
    </section>
  );
}
