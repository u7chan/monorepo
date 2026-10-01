import type { AgentDef } from "../../types";
import { AgentLabel } from "./AgentLabel";
import { AgentPicker } from "./AgentPicker";
import { fieldLabelClass } from "./fieldStyles";

export function AgentField({
  agents,
  agentId,
  compact,
  sessionAgent,
  onChangeAgent,
}: {
  agents: AgentDef[];
  agentId: string;
  compact: boolean;
  /** セッションを開いているときの表示 (作成時のスナップショット)。渡されている間は選べるプルダウンにしない */
  sessionAgent?: { name: string; icon?: string };
  onChangeAgent: (agentId: string) => void;
}) {
  return (
    // button も labelable なので label にすると、見出しのクリックがトリガーの activation へ転送されて
    // light dismiss と二重に走り得る。読み上げ名はトリガーの aria-label が持つ
    <div className={fieldLabelClass(compact)}>
      <span className="shrink-0">エージェント</span>
      {sessionAgent ? (
        <AgentLabel agents={agents} name={sessionAgent.name} icon={sessionAgent.icon} compact={compact} />
      ) : (
        <AgentPicker agents={agents} agentId={agentId} compact={compact} onChangeAgent={onChangeAgent} />
      )}
    </div>
  );
}
