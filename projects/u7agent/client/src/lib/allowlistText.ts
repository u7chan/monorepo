/**
 * エージェント編集のタブと、スキル / ツールの許可リスト欄で共有する文言。
 * 同じ操作を 2 つの欄へ書き写すと、片方だけ語がずれるため 1 箇所に置く。
 */
export type AgentSettingsTab = "basic" | "skills" | "tools" | "suggestions";

export const AGENT_TABS_ARIA_LABEL = "エージェントの面";
export const AGENT_TAB_LABELS: Record<AgentSettingsTab, string> = {
  basic: "基本",
  skills: "スキル",
  tools: "ツール",
  suggestions: "定型",
};
/** タブの件数。スキル / ツールは**割当**の件数で、スキル一覧の使用中エージェント数 (実効) とは別 */
export const AGENT_TAB_ASSIGN_LABEL = "割当";

/** 明示リストのときだけ出る「既定へ戻す」。null を送る操作で、未指定 (キー省略) とは区別する */
export const ALLOWLIST_RESET_LABEL = "すべて既定に戻す";
/** 明示リスト = 既定 (未指定) から変えた状態 */
export const ALLOWLIST_DIRTY_LABEL = "既定から変更あり";
export const ALLOWLIST_DEFAULT_LABEL = "既定のまま";
/** グループ見出しの一括操作。対象はそのグループの未絞込 visible 行 */
export const ALLOWLIST_DISABLE_GROUP_LABEL = "すべて外す";
export const ALLOWLIST_SEARCH_EMPTY_NOTE = "条件に合う行がありません。";
/** 一覧の検索欄。絞り込みは表示だけで、切替と一括操作の母集合は変えない */
export const AGENT_LIST_SEARCH_PLACEHOLDER = "名前・説明で絞り込む";
export const AGENT_LIST_SEARCH_ARIA_LABEL = "エージェントを絞り込む";
