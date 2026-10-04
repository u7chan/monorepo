import type { AgentDef } from "../../types";
import { AgentLabel } from "./AgentLabel";
import { AgentPicker } from "./AgentPicker";

/**
 * コンポーザーのエージェント欄。見出しの文字は出さない: 欄自身がアイコンと名前を持ち、compact では
 * 見出しの幅のぶんスキルのトリガーが次の行へ折り返す (読み上げ名はトリガーの aria-label が持つ)。
 */
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
  return sessionAgent ? (
    <AgentLabel agents={agents} name={sessionAgent.name} icon={sessionAgent.icon} compact={compact} />
  ) : (
    <AgentPicker agents={agents} agentId={agentId} compact={compact} onChangeAgent={onChangeAgent} />
  );
}
