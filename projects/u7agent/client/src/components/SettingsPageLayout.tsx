import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { ArrowLeftIcon, MenuIcon } from "./icons";
import { SettingsNoteRow } from "./SettingsNoteRow";

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
  // 無いときは列ごと出さない。空の列を残すと gap の分だけタイトルが右へずれる
  const hasHeaderButton = singleColumn || onOpenNav !== undefined;
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
      {/* 左の操作は auto 列で固定し、縮むのはタイトルの列だけにする。操作を縮めると、
          ラベルが縦に数文字へ潰れる */}
      <header
        className={cn(
          "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center border-b border-line",
          hasHeaderButton && "gap-x-2.5",
          singleColumn ? "px-4 pt-3.5 pb-3" : "px-5 pt-4 pb-3.5",
        )}
      >
        {hasHeaderButton ? (
          <div className="flex items-center gap-2.5">
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
          </div>
        ) : null}
        <div className="col-start-2 min-w-0">
          <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">{eyebrow}</div>
          <h2 className="text-lg font-semibold text-ink-strong">{title}</h2>
        </div>
        {/* singleColumn は説明を次の行へ出して全幅で読ませる。戻る / ☰ と横に並べると説明の幅が
            ボタンに削られ、同じ長さの文でも画面ごとに折り返しが変わる */}
        {caption ? (
          <div className={cn("min-w-0", singleColumn ? "col-span-full" : "col-start-2")}>{caption}</div>
        ) : null}
      </header>

      {tabs}

      {toolbar}

      {children}

      {/* ノートが無いページでは行ごと出さない (空の帯を残さない) */}
      {note ? <SettingsNoteRow note={note} /> : null}
    </section>
  );
}
