import type { AgentDef } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { agentFrameClass, agentLabelBoxClass } from "./fieldStyles";

/**
 * セッションを開いているときのエージェント欄。定義は作成時に promptSnapshot へ固定され、会話の途中では
 * 変えられないため、選べる見た目 (AgentPicker) にしない (選べない欄を入力欄の見た目にもしない)。寸法は
 * AgentPicker と共有し、最初の送信でプルダウンから入れ替わるときも行の幅と高さを動かさない。
 */
export function AgentLabel({
  agents,
  name,
  icon,
  compact,
}: {
  agents: AgentDef[];
  name: string;
  icon?: string;
  compact: boolean;
}) {
  return (
    <span className={agentFrameClass(compact)}>
      <span className={agentLabelBoxClass(compact)}>
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
