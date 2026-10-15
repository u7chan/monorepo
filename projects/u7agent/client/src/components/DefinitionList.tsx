import type { ReactNode } from "react";
import { MenuItem } from "./MenuItem";
import { PlusIcon } from "./icons";

export type DefinitionListProps = {
  /** 見出し (例: エージェント一覧) */
  title: string;
  count: number;
  addLabel: string;
  onAdd: () => void;
  /** count が 0 のとき追加行の下に出す文言。未指定なら何も出さない */
  emptyLabel?: string;
  children: ReactNode;
};

/**
 * 定義の一覧パネル (エージェント / スキル)。行の寸法は MenuItem が持つので、
 * ここは見出しと余白だけを揃える。追加行も同じ間隔で並べる (間隔を 1 箇所に固定する)。
 * 一覧と編集面を並べるのは 900px 以上だけで、狭いときはこの一覧がページ全体を使う (docs/ui-layout.md)。
 */
export function DefinitionList({ title, count, addLabel, onAdd, emptyLabel, children }: DefinitionListProps) {
  return (
    <aside className="flex min-h-0 min-w-0 flex-col wide:border-r wide:border-line">
      <div className="flex items-baseline gap-1.5 border-b border-line px-3 py-2 text-2xs font-semibold tracking-widest text-ink-faint uppercase">
        <span>{title}</span>
        <span className="font-normal">{count}</span>
      </div>
      <div className="min-h-0 min-w-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-3 py-2.5">
        <div className="grid min-w-0 content-start gap-1">
          <MenuItem variant="add" icon={<PlusIcon />} label={addLabel} onClick={onAdd} />
          {count === 0 && emptyLabel ? <p className="px-2 text-1xs leading-4 text-ink-faint">{emptyLabel}</p> : null}
          {children}
        </div>
      </div>
    </aside>
  );
}
