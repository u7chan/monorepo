import type { ReactNode } from "react";
import type { HandoffAgentChoice } from "../lib/sessionHandoff";
import { MenuItem } from "./MenuItem";

export type AgentChoiceListProps = {
  /** 一覧の見出し。ダイアログの文言が持つ */
  label: string;
  /** 現在のエージェントを先頭に置いた候補 */
  agents: HandoffAgentChoice[];
  agentId: string;
  onSelect: (agentId: string) => void;
  /** 一覧の下に置く補足。分岐だけが「何を引き継ぐか」を出す */
  children?: ReactNode;
};

/**
 * ダイアログで移動先のエージェントを 1 つ選ぶ一覧。現在のエージェントは名前に印を付けて残す
 * （カタログから消えていても選べる）。
 */
export function AgentChoiceList({ label, agents, agentId, onSelect, children }: AgentChoiceListProps) {
  return (
    <div className="grid gap-1.5">
      <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">{label}</span>
      <div className="grid gap-1">
        {agents.map((agent) => (
          <MenuItem
            key={agent.id}
            label={agent.current ? `${agent.name}（現在）` : agent.name}
            variant="choice"
            selected={agent.id === agentId}
            current="true"
            onClick={() => onSelect(agent.id)}
          />
        ))}
      </div>
      {children}
    </div>
  );
}
