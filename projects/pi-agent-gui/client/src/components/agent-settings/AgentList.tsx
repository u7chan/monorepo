import type { AgentDef } from "../../types";
import { PlusIcon } from "../icons";

/** 長い説明文が一覧のグリッド幅を押し広げないようにする。 */
const itemClass = (active: boolean) =>
  [
    "flex min-w-0 w-full cursor-pointer flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
    active ? "border-accent/35 bg-accent-wash" : "border-transparent bg-soft hover:bg-hover",
  ].join(" ");

export function AgentList({
  agents,
  editingId,
  onSelect,
  onStartNew,
}: {
  agents: AgentDef[];
  editingId: string | null;
  onSelect: (agentId: string) => void;
  onStartNew: () => void;
}) {
  return (
    <aside className="flex min-h-0 min-w-0 flex-col wide:border-r wide:border-line">
      <div className="flex items-baseline gap-1.5 border-b border-line px-3 py-2 text-2xs font-semibold uppercase tracking-widest text-ink-faint">
        <span>エージェント一覧</span>
        <span className="font-normal">{agents.length}</span>
      </div>
      <div className="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3 max-h-[30vh] wide:max-h-none">
        <button
          type="button"
          onClick={onStartNew}
          className="mb-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-2 text-1xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
        >
          <PlusIcon />
          新しいエージェント
        </button>
        <div className="grid min-w-0 gap-1">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelect(agent.id)}
              className={itemClass(editingId === agent.id)}
            >
              <strong className="min-w-0 truncate text-xs text-ink">{agent.name}</strong>
              <span className="min-w-0 truncate text-2xs text-ink-muted">{agent.description || "説明なし"}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
