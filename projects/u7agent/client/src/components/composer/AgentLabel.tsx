import type { AgentDef } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { agentFrameClass, agentLabelBoxClass } from "./fieldStyles";

/**
 * セッションを開いているときのエージェント欄。定義は作成時に promptSnapshot へ固定され途中では
 * 変えられないので、選べる見た目にしない (寸法は AgentPicker と共有し、送信後も行を動かさない)。
 */
export function AgentLabel({
  agents,
  name,
  icon,
  singleColumn,
}: {
  agents: AgentDef[];
  name: string;
  icon?: string;
  singleColumn: boolean;
}) {
  return (
    <span className={agentFrameClass(singleColumn)}>
      <span className={agentLabelBoxClass(singleColumn)}>
        {/* sizer は AgentPicker と同じ (最長の候補名で幅が決まる)。入れ替わりで欄の幅を変えない */}
        {agents.map((agent) => (
          <span key={agent.id} aria-hidden="true" className="invisible col-start-1 row-start-1 truncate">
            {agent.name}
          </span>
        ))}
        <span className="col-start-1 row-start-1 min-w-0 truncate">{name}</span>
      </span>
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center">
        <AgentIcon icon={icon} variant="inline" />
      </span>
    </span>
  );
}
