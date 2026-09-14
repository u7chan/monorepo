import type { AgentDef } from "../../types";
import { SelectField } from "../SelectField";
import { fieldLabelClass, selectClass, selectWrapperClass } from "./fieldStyles";

export function AgentField({
  agents,
  agentId,
  compact,
  onChangeAgent,
}: {
  agents: AgentDef[];
  agentId: string;
  compact: boolean;
  /** 選択中のエージェントで新しい会話を始める */
  onChangeAgent: (agentId: string) => void;
}) {
  return (
    <label className={fieldLabelClass(compact)}>
      <span className="shrink-0">エージェント</span>
      <SelectField
        aria-label="エージェントを選択"
        className={selectClass(compact)}
        wrapperClassName={selectWrapperClass(compact, "max-w-[200px]")}
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
