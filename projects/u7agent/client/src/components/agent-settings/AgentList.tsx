import { useRef } from "react";
import { useAgentDrag } from "../../hooks/useAgentDrag";
import { cn } from "../../lib/cn";
import type { AgentDef } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { DefinitionList } from "../DefinitionList";
import { MenuItem } from "../MenuItem";
import { GripIcon } from "../icons";

export function AgentList({
  agents,
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
  const drag = useAgentDrag({
    containerRef,
    ids: reorderIds,
    onMove: onReorder,
    onCommit: onCommitOrder,
    onCancel: onCancelOrder,
    disabled: reorderDisabled,
  });
  const reorderable = new Set(reorderIds);

  return (
    <DefinitionList title="エージェント一覧" count={agents.length} addLabel="新しいエージェント" onAdd={onStartNew}>
      <div ref={containerRef} className="grid min-w-0 content-start gap-1">
        {agents.map((agent) => (
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
                className="agent-drag-grip"
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
