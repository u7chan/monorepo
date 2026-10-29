/**
 * アプリ同梱の組み込み定義（汎用アシスタントの同一性と定型プロンプトの本文）。
 * 定型文の本文をエージェント側と新規 DB の seed の両方へ写さないため、1 箇所に置く。
 * 組み込みプロンプトの ID は固定で、DB の行は起動時に `AppDb` がこの定義へ同期する
 * (docs/persistence.md)。
 */
import type { PromptKind } from "./schema";

/** 汎用アシスタント。DB の行にはせず、常にこの ID の固定定義を返す */
export const BUILTIN_AGENT_ID = "agent-general";
export const BUILTIN_AGENT_NAME = "汎用アシスタント";
export const BUILTIN_AGENT_DESCRIPTION = "役割や口調を設定していない既定のエージェント";

export interface BuiltinPromptDefinition {
  id: string;
  kind: Extract<PromptKind, "builtin">;
  label: string;
  prompt: string;
}

/**
 * 汎用アシスタントが固定で参照する定型プロンプト。並びがそのまま表示順になる。
 * 利用者は参照も編集もできない（変更したい内容は自作マスタとして登録する）。
 */
export const BUILTIN_PROMPTS: readonly BuiltinPromptDefinition[] = [
  {
    id: "prompt-builtin-project-overview",
    kind: "builtin",
    label: "プロジェクトを説明して",
    prompt: "このプロジェクトの構成を簡単に教えて",
  },
  {
    id: "prompt-builtin-check-tests",
    kind: "builtin",
    label: "テストを確認して",
    prompt: "まずテストがあるか確認して",
  },
  {
    id: "prompt-builtin-review-readme",
    kind: "builtin",
    label: "README をレビューして",
    prompt: "README を読んで改善案を3つ出して",
  },
];

/** 汎用アシスタントの固定参照 (順序 = 表示順)。`agent_prompts` の外部キーは弱めない */
export const BUILTIN_AGENT_PROMPT_IDS: readonly string[] = BUILTIN_PROMPTS.map((entry) => entry.id);
