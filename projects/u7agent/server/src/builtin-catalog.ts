/**
 * アプリ同梱の組み込み定義（汎用アシスタントの同一性）。
 * 汎用アシスタントは DB の行にせず、常にこの ID の固定定義を返す。
 */

/** 汎用アシスタント。DB の行にはせず、常にこの ID の固定定義を返す */
export const BUILTIN_AGENT_ID = "agent-general";
export const BUILTIN_AGENT_NAME = "汎用アシスタント";
export const BUILTIN_AGENT_DESCRIPTION = "役割や口調を設定していない既定のエージェント";
