import type { AgentDef } from "../types";

/**
 * セッションのスナップショットは、カタログから消えたエージェントを指していることがある
 * (定義はメモリ内で、削除やインポートで変わる)。存在しない id を選択に残すと次のセッション作成が
 * 400 (Agent not found) になるため、カタログにある id だけを採用する。
 */
export function adoptKnownAgentId(agents: AgentDef[], snapshotId: string | undefined, currentId: string): string {
  return snapshotId && agents.some((agent) => agent.id === snapshotId) ? snapshotId : currentId;
}
