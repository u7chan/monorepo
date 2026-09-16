import type { AgentDef } from "../../types";
import { SelectField } from "../SelectField";
import { fieldLabelClass } from "./fieldStyles";

export function AgentField({
  agents,
  agentId,
  compact,
  onChangeAgent,
}: {
  agents: AgentDef[];
  agentId: string;
  compact: boolean;
  onChangeAgent: (agentId: string) => void;
}) {
  return (
    <label className={fieldLabelClass(compact)}>
      <span className="shrink-0">エージェント</span>
      <SelectField
        aria-label="エージェントを選択"
        density="sm"
        compact={compact}
        wrapperClassName={compact ? "min-w-0 flex-1" : "min-w-0 max-w-50"}
        value={agentId}
        disabled={agents.length === 0}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next !== agentId) onChangeAgent(next);
        }}
      >
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </SelectField>
    </label>
  );
}
