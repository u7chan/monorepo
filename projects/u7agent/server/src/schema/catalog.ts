/**
 * エージェント / 定型プロンプト / ツールのカタログと要求 body。DTO のフィールド名と optional の扱いは client と揃える。
 * 応答の契約は docs/api-catalog.md を正とし、ここには型から読めない不変条件と Why not だけを書く。
 */
import { z } from "zod";
import {
  ModelRefSchema,
  SKILL_NAMES_MAX,
  SKILL_NAME_MAX,
  TOOL_NAMES_MAX,
  TOOL_NAME_MAX,
  ThinkingLevelSchema,
} from "./common";

/** 定型プロンプトのマスタ (`PromptRefSchema`) と、マスタに属さない引き継ぎのチップが同じ形を使う */
export const AgentSuggestionSchema = z.object({
  label: z.string(),
  prompt: z.string(),
});
export type AgentSuggestion = z.infer<typeof AgentSuggestionSchema>;
/** マスタの種別。現在は自作のみで、旧版の builtin 行は起動時に消す */
export const PromptKindSchema = z.enum(["builtin", "custom"]);
export type PromptKind = z.infer<typeof PromptKindSchema>;
/**
 * マスタのラベル・本文・ID の上限。ラベルと本文は旧 `suggestions` の編集上限を引き継ぐ。
 * エージェント 1 体の参照上限は `AGENT_PROMPT_LIMIT` (マスタ全体には上限を掛けない)。
 */
export const AGENT_PROMPT_LIMIT = 6;
export const PROMPT_LABEL_MAX = 60;
export const PROMPT_TEXT_MAX = 500;
export const PROMPT_ID_MAX = 100;
/**
 * エージェントに解決済みで載る定型プロンプト 1 件。表示の同一性は `id` で持ち、
 * 同じ本文の別マスタを本文でまとめない。
 */
export const PromptRefSchema = z.object({
  id: z.string(),
  kind: PromptKindSchema,
  label: z.string(),
  prompt: z.string(),
});
export type PromptRef = z.infer<typeof PromptRefSchema>;
/** マスタの使用先 1 件 */
export const PromptUsageSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
});
export type PromptUsage = z.infer<typeof PromptUsageSchema>;
/** 使用先を伴い、削除できない理由を画面が説明できる */
export const PromptDefSchema = PromptRefSchema.extend({ usedBy: z.array(PromptUsageSchema) });
export type PromptDef = z.infer<typeof PromptDefSchema>;
export const PromptsResponseSchema = z.object({ prompts: z.array(PromptDefSchema) });
export type PromptsResponse = z.infer<typeof PromptsResponseSchema>;
/**
 * 並べ替えで受ける id の上限。形と上限だけを見る点は `ReorderAgentsBodySchema` と同じで、
 * 未知の id・重複・組み込みの扱いは `PromptCatalog.reorder` が正。
 */
export const PROMPT_ORDER_IDS_MAX = 500;
export const ReorderPromptsBodySchema = z.object({ ids: z.array(z.string()).max(PROMPT_ORDER_IDS_MAX) });
export type ReorderPromptsBody = z.infer<typeof ReorderPromptsBodySchema>;
export const PromptResponseSchema = z.object({ prompt: PromptDefSchema });
export type PromptResponse = z.infer<typeof PromptResponseSchema>;
/** 使用中の自作マスタの削除拒否 (409) の応答。データは変更しない */
export const PromptDeleteConflictSchema = z.object({ error: z.string(), usedBy: z.array(PromptUsageSchema) });
export type PromptDeleteConflict = z.infer<typeof PromptDeleteConflictSchema>;
export const ToolGroupSchema = z.enum(["sandbox", "app"]);
export type ToolGroup = z.infer<typeof ToolGroupSchema>;
/** アプリ側でツールを使えない理由のコード。文言はクライアントが持ち、応答にはコードだけを載せる */
export const ToolUnavailableReasonSchema = z.enum(["deploy_allowlist", "app_disabled", "no_key", "no_auth"]);
export type ToolUnavailableReason = z.infer<typeof ToolUnavailableReasonSchema>;
export const ToolCatalogEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  group: ToolGroupSchema,
  available: z.boolean(),
  reason: ToolUnavailableReasonSchema.optional(),
});
export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>;
export const AgentDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  commonSkillNames: z.array(z.string()).optional(),
  builtinSkillNames: z.array(z.string()).optional(),
  allowNaturalInvocationBuiltin: z.boolean().optional(),
  allowNaturalInvocationFile: z.boolean().optional(),
  toolNames: z.array(z.string()).optional(),
  /** プリセットの実体はクライアントが解決する */
  icon: z.string().optional(),
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  prompts: z.array(PromptRefSchema).optional(),
});
export type AgentDef = z.infer<typeof AgentDefSchema>;
export const BuiltinSkillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** 同梱物の版。SKILL.md を変えたら上がる (builtin-skills.ts の VERSIONS) */
  version: z.string(),
});
export type BuiltinSkillInfo = z.infer<typeof BuiltinSkillInfoSchema>;
export const CatalogResponseSchema = z.object({
  agents: z.array(AgentDefSchema),
  builtinAgent: AgentDefSchema.nullable(),
  builtinSkills: z.array(BuiltinSkillInfoSchema),
  tools: z.array(ToolCatalogEntrySchema),
  prompts: z.array(PromptRefSchema),
});
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;
/**
 * セッション作成時に meta へ固定するエージェントのスナップショット。
 * スキルの実体はファイル側の現行定義を使い、ここには割り当てを保存しない。
 */
export const AgentPayloadInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  commonSkillNames: z.array(z.string()).optional(),
  builtinSkillNames: z.array(z.string()).optional(),
  allowNaturalInvocationBuiltin: z.boolean().optional(),
  allowNaturalInvocationFile: z.boolean().optional(),
  toolNames: z.array(z.string()).optional(),
});
export type AgentPayloadInfo = z.infer<typeof AgentPayloadInfoSchema>;
// 全キー任意にするのは、空 body の PATCH を no-op として通し、必須判定を catalog の文言のまま残すため。
// null は「指定解除」、キー省略は「現在値の維持」で、どちらも catalog が解釈する。
const agentBodyShape = {
  name: z.string().optional(),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  /**
   * 撤去済みの DB カタログ割り当て。**形は受けるが値は catalog が拒否する** (400)。
   * ここで `z.never()` にすると「キーが存在すること」を route が説明できず、
   * 別の理由の 400 と区別できない。
   */
  skillIds: z.unknown().optional(),
  commonSkillNames: z.array(z.string().max(SKILL_NAME_MAX)).max(SKILL_NAMES_MAX).nullish(),
  builtinSkillNames: z.array(z.string().max(SKILL_NAME_MAX)).max(SKILL_NAMES_MAX).nullish(),
  allowNaturalInvocationBuiltin: z.boolean().nullish(),
  allowNaturalInvocationFile: z.boolean().nullish(),
  /**
   * 分割前の 1 本のフラグ。**形だけ受けて catalog が 400 にする** (未知キーとして黙って落とすと、
   * 旧クライアントの保存が成功したように見える)。値の解釈は DB 移行と旧 meta の読み取りだけが行う。
   */
  allowNaturalInvocation: z.boolean().nullish(),
  toolNames: z.array(z.string().max(TOOL_NAME_MAX)).max(TOOL_NAMES_MAX).nullish(),
  icon: z.string().nullish(),
  model: ModelRefSchema.nullish(),
  thinkingLevel: ThinkingLevelSchema.nullish(),
  promptIds: z.array(z.string().max(PROMPT_ID_MAX)).max(AGENT_PROMPT_LIMIT).nullish(),
  /**
   * 撤去済みの直接書き込み。**形は受けるが値は catalog が拒否する** (400)。
   * 黙って捨てると保存できたと誤認させるため、`skillIds` と同じ扱いにする。
   */
  suggestions: z.unknown().optional(),
};
export const CreateAgentBodySchema = z.object(agentBodyShape);
export type CreateAgentBody = z.infer<typeof CreateAgentBodySchema>;
export const UpdateAgentBodySchema = z.object(agentBodyShape);
export type UpdateAgentBody = z.infer<typeof UpdateAgentBodySchema>;
/**
 * マスタの作成 / 更新。種別と ID はサーバーが決める。**形は受けるが catalog が拒否する** (400)
 * (`suggestions` と同じ理由で、route が「キーがある」ことを説明できる形にする)。
 * **作成は両項目が必須**で、省略・空文字は保存前に 400 にする (更新の「省略は保持」と混ぜない)。
 */
const promptManagedKeys = {
  id: z.unknown().optional(),
  kind: z.unknown().optional(),
};
export const CreatePromptBodySchema = z.object({
  label: z.string().max(PROMPT_LABEL_MAX),
  prompt: z.string().max(PROMPT_TEXT_MAX),
  ...promptManagedKeys,
});
export type CreatePromptBody = z.infer<typeof CreatePromptBodySchema>;
export const UpdatePromptBodySchema = z.object({
  label: z.string().max(PROMPT_LABEL_MAX).optional(),
  prompt: z.string().max(PROMPT_TEXT_MAX).optional(),
  ...promptManagedKeys,
});
export type UpdatePromptBody = z.infer<typeof UpdatePromptBodySchema>;
/**
 * 並べ替えで受ける id の上限。全件を 1 回で渡す API なので、他の配列項目と同じく
 * 中身の正しさ (存在・重複) はカタログ側が正で、ここは形と上限だけを見る。
 */
export const AGENT_ORDER_IDS_MAX = 200;
export const ReorderAgentsBodySchema = z.object({ ids: z.array(z.string()).max(AGENT_ORDER_IDS_MAX) });
export type ReorderAgentsBody = z.infer<typeof ReorderAgentsBodySchema>;
