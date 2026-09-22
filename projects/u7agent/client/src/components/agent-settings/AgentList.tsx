import { AgentIcon } from "../AgentIcon";
import { DefinitionList } from "../DefinitionList";
import { MenuItem } from "../MenuItem";
import type { AgentDef } from "../../types";

export function AgentList({
  agents,
  editingId,
  compact = false,
  onSelect,
  onStartNew,
}: {
  agents: AgentDef[];
  editingId: string | null;
  compact?: boolean;
  onSelect: (agentId: string) => void;
  onStartNew: () => void;
}) {
  return (
    <DefinitionList
      title="エージェント一覧"
      count={agents.length}
      addLabel="新しいエージェント"
      onAdd={onStartNew}
      compact={compact}
    >
      {agents.map((agent) => (
        <MenuItem
          key={agent.id}
          icon={<AgentIcon icon={agent.icon} variant="list" />}
          label={agent.name}
          description={agent.description || "説明なし"}
          selected={editingId === agent.id}
          current="true"
          onClick={() => onSelect(agent.id)}
        />
      ))}
    </DefinitionList>
  );
}
