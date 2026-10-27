import type { ReactNode } from "react";

export type DefinitionListProps = {
  /** 見出し (例: エージェント一覧)。スコープタブが同じ役目を持つ一覧では省略する */
  title?: string;
  count?: number;
  /** 見出しの下・検索の上に置く面のタブ行 (スキルのスコープ) */
  tabs?: ReactNode;
  /** 一覧の上に置く検索欄。絞り込みは表示だけで、選択や一括操作の母集合は変えない */
  search?: ReactNode;
  /**
   * 一覧の下端に固定する操作 (追加 / インポート / エクスポート)。件数に比例して下がる位置へ
   * 置かないため、スクロールする行の外に出す。取得できていないなど操作できない事情があるときは
   * 渡さない (できない理由は一覧側の注記が出す)
   */
  footer?: ReactNode;
  /**
   * 行が無いときに出す文言。出すかは呼び出し側が決める (検索で絞った結果が 0 件のときも出すため、
   * 未絞込の `count` では判定しない)
   */
  emptyLabel?: string;
  children: ReactNode;
};

/**
 * 定義の一覧パネル (エージェント / スキル)。行の寸法は MenuItem が持つので、
 * ここは見出し・絞り込み・固定フッターと余白だけを揃える。
 * 一覧と編集面を並べるのは 900px 以上だけで、狭いときはこの一覧がページ全体を使う (docs/ui-layout.md)。
 */
export function DefinitionList({ title, count, tabs, search, footer, emptyLabel, children }: DefinitionListProps) {
  return (
    <aside className="flex min-h-0 min-w-0 flex-col wide:border-r wide:border-line">
      {title ? (
        <div className="flex shrink-0 items-baseline gap-1.5 border-b border-line px-3 py-2 text-2xs font-semibold tracking-widest text-ink-faint uppercase">
          <span>{title}</span>
          {count === undefined ? null : <span className="font-normal">{count}</span>}
        </div>
      ) : null}
      {tabs ? <div className="shrink-0">{tabs}</div> : null}
      {search ? <div className="shrink-0 px-3 py-2">{search}</div> : null}
      <div className="min-h-0 min-w-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-3 py-2.5">
        <div className="grid min-w-0 content-start gap-1">
          {emptyLabel ? <p className="px-2 text-1xs leading-4 text-ink-faint">{emptyLabel}</p> : null}
          {children}
        </div>
      </div>
      {/* 追加やエクスポートは件数に依らず常に同じ位置に置く (スクロールする行の外) */}
      {footer ? <div className="shrink-0 border-t border-line px-3 py-2">{footer}</div> : null}
    </aside>
  );
}
