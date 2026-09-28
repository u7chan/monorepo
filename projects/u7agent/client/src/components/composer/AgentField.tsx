import type { AgentDef } from "../../types";
import { fieldLabelClass } from "./fieldStyles";
import { AgentPicker } from "./AgentPicker";

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
    // button も labelable なので label にすると、見出しのクリックがトリガーの activation へ転送されて
    // light dismiss と二重に走り得る。読み上げ名はトリガーの aria-label が持つ
    <div className={fieldLabelClass(compact)}>
      <span className="shrink-0">エージェント</span>
      <AgentPicker agents={agents} agentId={agentId} compact={compact} onChangeAgent={onChangeAgent} />
    </div>
  );
}
