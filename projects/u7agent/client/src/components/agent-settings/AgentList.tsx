import { useRef, useState } from "react";
import { useAgentDrag } from "../../hooks/useAgentDrag";
import { AGENT_LIST_SEARCH_ARIA_LABEL, AGENT_LIST_SEARCH_PLACEHOLDER } from "../../lib/allowlistText";
import { cn } from "../../lib/cn";
import { filterBySearch } from "../../lib/settingsSearch";
import type { AgentDef } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { DefinitionList } from "../DefinitionList";
import { MenuItem } from "../MenuItem";
import { SettingsSearchField } from "../SettingsSearchField";
import { GripIcon, PlusIcon } from "../icons";

export function AgentList({
  agents,
  builtinId,
  reorderIds,
  editingId,
  onSelect,
  onStartNew,
  onReorder,
  onCommitOrder,
  onCancelOrder,
  reorderDisabled = false,
}: {
  agents: AgentDef[];
  /** ビルトインの id。先頭固定で並べ替えの対象にしない (バッジも出す) */
  builtinId?: string;
  /** グリップで動かせる行の id（表示順）。ビルトインは含めない */
  reorderIds: readonly string[];
  editingId: string | null;
  onSelect: (agentId: string) => void;
  onStartNew: () => void;
  /** ドラッグ中の live 差し替え */
  onReorder: (ids: string[]) => void;
  /** 移動があったときの確定 */
  onCommitOrder: () => void;
  /** 取り消し */
  onCancelOrder: () => void;
  /** 保存中は新しいドラッグを開始させない */
  reorderDisabled?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  // 検索中は並べ替えを開かない: 非表示の行との順序を決められず、確定すると見えていない行まで動く
  const dragDisabled = reorderDisabled || searching;
  const drag = useAgentDrag({
    containerRef,
    ids: reorderIds,
    onMove: onReorder,
    onCommit: onCommitOrder,
    onCancel: onCancelOrder,
    disabled: dragDisabled,
  });
  const reorderable = new Set(searching ? [] : reorderIds);
  const visible = filterBySearch(agents, query, (agent) => [agent.name, agent.description]);

  return (
    <DefinitionList
      title="エージェント一覧"
      count={agents.length}
      search={
        <SettingsSearchField
          value={query}
          onChange={setQuery}
          placeholder={AGENT_LIST_SEARCH_PLACEHOLDER}
          ariaLabel={AGENT_LIST_SEARCH_ARIA_LABEL}
        />
      }
      footer={
        <button
          type="button"
          onClick={onStartNew}
          className="flex min-h-11 w-full min-w-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-3 text-1xs text-ink-soft transition-colors hover:border-accent/50 hover:bg-hover hover:text-accent-text"
        >
          <PlusIcon />
          新しいエージェント
        </button>
      }
      // 行が 1 件も無いときは、全件 0 件でも検索外れでも空状態を出す (未絞込の count では判定しない)
      emptyLabel={visible.length === 0 ? "条件に合うエージェントがありません。" : undefined}
    >
      <div ref={containerRef} className="grid min-w-0 content-start gap-1" {...drag.containerHandlers}>
        {visible.map((agent) => (
          <div
            key={agent.id}
            data-agent-row={agent.id}
            className={cn("flex min-w-0 items-stretch gap-1", drag.draggingId === agent.id && "agent-drag-row")}
          >
            <div className="min-w-0 flex-1">
              <MenuItem
                icon={<AgentIcon icon={agent.icon} variant="list" />}
                label={agent.name}
                description={agent.description || "説明なし"}
                status={agent.id === builtinId ? { text: "組み込み", tone: "muted" } : undefined}
                selected={editingId === agent.id}
                current="true"
                onClick={() => onSelect(agent.id)}
              />
            </div>
            {reorderable.has(agent.id) ? (
              // グリップは行の button の外に置く（中に入れるとクリックが選択として伝播する）
              <button
                type="button"
                aria-label={`${agent.name}の順番を変更`}
                className="drag-grip"
                {...drag.gripHandlers(agent.id)}
              >
                <GripIcon />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </DefinitionList>
  );
}
