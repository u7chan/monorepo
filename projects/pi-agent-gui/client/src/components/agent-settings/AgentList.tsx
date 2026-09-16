import { DefinitionList } from "../DefinitionList";
import { MenuItem } from "../MenuItem";
import { SparkleIcon } from "../icons";
import type { AgentDef } from "../../types";

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
    <DefinitionList title="エージェント一覧" count={agents.length} addLabel="新しいエージェント" onAdd={onStartNew}>
      {agents.map((agent) => (
        <MenuItem
          key={agent.id}
          icon={<SparkleIcon />}
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
