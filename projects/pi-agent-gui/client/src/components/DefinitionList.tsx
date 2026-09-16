import type { ReactNode } from "react";
import { MenuItem } from "./MenuItem";
import { PlusIcon } from "./icons";

export type DefinitionListProps = {
  /** 見出し (例: エージェント一覧) */
  title: string;
  count: number;
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
};

/**
 * 定義の一覧パネル (エージェント / スキル)。行の寸法は MenuItem が持つので、
 * ここは見出しと余白だけを揃える。追加行も同じ間隔で並べる (間隔を 1 箇所に固定する)。
 */
export function DefinitionList({ title, count, addLabel, onAdd, children }: DefinitionListProps) {
  return (
    <aside className="flex min-h-0 min-w-0 flex-col wide:border-r wide:border-line">
      <div className="flex items-baseline gap-1.5 border-b border-line px-3 py-2 text-2xs font-semibold tracking-widest text-ink-faint uppercase">
        <span>{title}</span>
        <span className="font-normal">{count}</span>
      </div>
      <div className="max-h-[30vh] min-h-0 min-w-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-3 py-2.5 wide:max-h-none">
        <div className="grid min-w-0 content-start gap-1">
          <MenuItem variant="add" icon={<PlusIcon />} label={addLabel} onClick={onAdd} />
          {children}
        </div>
      </div>
    </aside>
  );
}
