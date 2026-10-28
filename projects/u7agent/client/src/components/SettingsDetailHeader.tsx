import type { ReactNode, Ref } from "react";
import { ArrowLeftIcon } from "./icons";

/**
 * 設定の詳細面のヘッダ。並列表示では戻る導線を出さず、`singleColumn || !wide` のときだけ
 * 「一覧へ戻る」を左端に置く。詳細へ入ったときのフォーカス先にもなる (`tabIndex={-1}`)。
 */
export function SettingsDetailHeader({
  back,
  leading,
  title,
  heading,
  badge,
  actions,
  ref,
}: {
  /** 一覧へ戻る導線。並列表示では渡さない */
  back?: { label: string; onClick: () => void };
  leading?: ReactNode;
  /** 現在名 (エージェントではピッカー)。見出しとしてフォーカスを受ける */
  title: ReactNode;
  /**
   * 詳細面の見出し (読み上げと見出し移動のため)。ページのヘッダを畳む面では、画面から `h2` が
   * 消えて見出し移動の起点が無くなるので、現在名と同じ文字列を sr-only の `h2` として残す
   */
  heading?: string;
  badge?: ReactNode;
  actions?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <header
      ref={ref}
      tabIndex={-1}
      className="flex min-w-0 shrink-0 items-center gap-2 border-b border-line px-3 py-2 focus:outline-none"
    >
      {back ? (
        <button
          type="button"
          onClick={back.onClick}
          aria-label={back.label}
          title={back.label}
          className="grid size-11 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
        >
          <ArrowLeftIcon />
        </button>
      ) : null}
      {leading ? <span className="shrink-0">{leading}</span> : null}
      <div className="grid min-w-0 flex-1 gap-0.5">
        {heading ? <h2 className="sr-only">{heading}</h2> : null}
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="min-w-0">{title}</div>
          {badge ? <div className="flex shrink-0 items-center gap-1.5">{badge}</div> : null}
        </div>
      </div>
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}
