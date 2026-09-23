import type { AgentDef, CatalogResponse } from "../types";

/**
 * 選択肢の並び。ビルトインは置換対象の agents に含まれないので、ここで先頭に合成する
 * (コンポーザーのピッカー・設定ページの一覧・セッションの選択復元はこの並びで見る)。
 */
export function selectableAgents(catalog: CatalogResponse): AgentDef[] {
  return catalog.builtinAgent ? [catalog.builtinAgent, ...catalog.agents] : catalog.agents;
}

/**
 * セッションのスナップショットは、カタログから消えたエージェントを指していることがある
 * (定義は削除やインポートで変わる)。存在しない id を選択に残すと次のセッション作成が
 * 400 (Agent not found) になるため、カタログにある id だけを採用する。
 */
export function adoptKnownAgentId(agents: AgentDef[], snapshotId: string | undefined, currentId: string): string {
  return snapshotId && agents.some((agent) => agent.id === snapshotId) ? snapshotId : currentId;
}
