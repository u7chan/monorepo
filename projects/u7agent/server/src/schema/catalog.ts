/** エージェント / 定型プロンプト / ツールのカタログと要求 body。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";
import {
  ModelRefSchema,
  SKILL_NAMES_MAX,
  SKILL_NAME_MAX,
  TOOL_NAMES_MAX,
  TOOL_NAME_MAX,
  ThinkingLevelSchema,
} from "./common";

/**
 * 入力欄のチップ 1 件。label がボタン文言、prompt が送信文字列。
 * 定型プロンプトのマスタ (`PromptRefSchema`) と、マスタに属さない引き継ぎのチップが同じ形を使う。
 */
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
/** マスタの使用先 1 件。旧クライアント互換のため builtin を持つ (現在は常に false) */
export const PromptUsageSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  /** 組み込みエージェントの固定参照か (DB の紐づけではない) */
  builtin: z.boolean(),
});
export type PromptUsage = z.infer<typeof PromptUsageSchema>;
/** `GET /api/prompts` の 1 件。使用先を伴い、削除できない理由を画面が説明できる */
export const PromptDefSchema = PromptRefSchema.extend({ usedBy: z.array(PromptUsageSchema) });
export type PromptDef = z.infer<typeof PromptDefSchema>;
/** `GET /api/prompts` の応答。並びはサーバーが決める (保存した順) */
export const PromptsResponseSchema = z.object({ prompts: z.array(PromptDefSchema) });
export type PromptsResponse = z.infer<typeof PromptsResponseSchema>;
/**
 * 並べ替えで受ける id の上限。形と上限だけを見る点は `ReorderAgentsBodySchema` と同じで、
 * 未知の id・重複・組み込みの扱いは `PromptCatalog.reorder` が正。
 */
export const PROMPT_ORDER_IDS_MAX = 500;
export const ReorderPromptsBodySchema = z.object({ ids: z.array(z.string()).max(PROMPT_ORDER_IDS_MAX) });
export type ReorderPromptsBody = z.infer<typeof ReorderPromptsBodySchema>;
/** `POST /api/prompts` の応答。作成した 1 件を使用先 (空) つきで返す */
export const PromptResponseSchema = z.object({ prompt: PromptDefSchema });
export type PromptResponse = z.infer<typeof PromptResponseSchema>;
/**
 * 使用中の自作マスタの削除拒否 (409) の応答。どこで使われているかを画面がそのまま出せるようにする。
 * データは変更しない (docs/api-catalog.md)。
 */
export const PromptDeleteConflictSchema = z.object({ error: z.string(), usedBy: z.array(PromptUsageSchema) });
export type PromptDeleteConflict = z.infer<typeof PromptDeleteConflictSchema>;
/**
 * ツール 1 件の種別。`sandbox` はサンドボックスで動く作業ツール、`app` は BFF ローカルのツール。
 * 画面のグループ分けに使う (`docs/api-catalog.md#ツール許可リスト`)。
 */
export const ToolGroupSchema = z.enum(["sandbox", "app"]);
export type ToolGroup = z.infer<typeof ToolGroupSchema>;
/**
 * アプリ側でツールを使えない理由のコード。文言はクライアントの lib が持ち、応答にはコードだけを載せる
 * (既存の分担は `client/src/lib/fileSkills.ts` / `client/src/lib/settingsNotes.ts`)。
 * `no_key` は OpenRouter のキー未登録、`no_auth` は Codex のサインインが無いことを表す
 * (画像は選択 provider の認証で決まる。docs/api-catalog.md)。
 */
export const ToolUnavailableReasonSchema = z.enum(["deploy_allowlist", "app_disabled", "no_key", "no_auth"]);
export type ToolUnavailableReason = z.infer<typeof ToolUnavailableReasonSchema>;
/**
 * `GET /api/agents` が返すツール 1 件 (`builtinSkills` と同じ位置づけ)。`available` は取得時点の
 * アプリ側の実効で、エージェントの許可リストは掛けない (許可リストと一緒に画面が判断する)。
 * `reason` は `available: false` のときだけ載る。
 */
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
  /**
   * 共通スキルの許可リスト。未指定 = 全可視、`[]` = すべて OFF (この 2 つは混同しない)。
   * プロジェクト / 組み込みのスキルは対象外 (docs/api-catalog.md)。
   */
  commonSkillNames: z.array(z.string()).optional(),
  /**
   * 組み込みスキルの許可リスト。未指定 = 全部 ON、`[]` = すべて OFF (この 2 つは混同しない)。
   * プロジェクト / 共通のスキルは対象外 (docs/api-catalog.md#組み込みスキル)。
   */
  builtinSkillNames: z.array(z.string()).optional(),
  /**
   * 組み込みスキルを自然文で発火させるか。未指定 = 発火する (既定)。false なら組み込みスキルを
   * `/skill:` とスキルボタンからのみ起動する (docs/api-catalog.md#自然文での発火)。
   */
  allowNaturalInvocationBuiltin: z.boolean().optional(),
  /**
   * ファイルスキル (共通 `.agents/skills` とプロジェクト `<cwd>/.agents/skills`) を自然文で発火させるか。
   * 未指定 = 発火する (既定)。組み込み側とは独立で、片方の false は他方へ波及しない。
   */
  allowNaturalInvocationFile: z.boolean().optional(),
  /**
   * ツールの許可リスト。未指定 = 全部 ON、`[]` = すべて OFF (この 2 つは混同しない)。実効は
   * アプリ側の可否との積で、アプリ側が止めているツールは許可リストに入れても使えない
   * (docs/api-catalog.md#ツール許可リスト)。
   */
  toolNames: z.array(z.string()).optional(),
  /**
   * プリセット ID (`preset:<id>`) または webp / png の data URL。未指定のときはキー自体を省略する
   * (null は保存・応答に現れない)。プリセットの実体はクライアントが解決する
   */
  icon: z.string().optional(),
  // 未指定のときはキー自体を省略する (null は保存・応答に現れない)
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  /**
   * 空の会話に出す定型プロンプト (参照先マスタを解決した値)。並びが表示順で、表示の同一性は `id`。
   * 未指定なら firstview のボタンを出さない (アプリ既定のフォールバックは持たない)。
   */
  prompts: z.array(PromptRefSchema).optional(),
});
export type AgentDef = z.infer<typeof AgentDefSchema>;
/**
 * アプリに同梱する組み込みスキル 1 件。エージェント定義の `builtinSkillNames`
 * でエージェント別に外すため、スキル欄の行に使う。
 */
export const BuiltinSkillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** 同梱物の版。SKILL.md を変えたら上がる (builtin-skills.ts の VERSIONS) */
  version: z.string(),
});
export type BuiltinSkillInfo = z.infer<typeof BuiltinSkillInfoSchema>;
/**
 * GET `/api/agents` の応答。`builtinAgent` はサーバー所有の汎用エージェントで、
 * `agents` (ユーザー定義) には含まれない。サーバーは常にオブジェクトを返し、
 * `null` はクライアントが取得前に持つ初期状態だけを表す。
 */
export const CatalogResponseSchema = z.object({
  agents: z.array(AgentDefSchema),
  builtinAgent: AgentDefSchema.nullable(),
  builtinSkills: z.array(BuiltinSkillInfoSchema),
  /** アプリが扱うツールの一覧 (`builtinSkills` と同じく、エージェント定義ではない) */
  tools: z.array(ToolCatalogEntrySchema),
  /**
   * 参照できる定型プロンプトのマスタ一覧 (選択肢)。エージェントに解決済みで載る `prompts` とは別で、
   * こちらは全件。並びはサーバーが決める (組み込みが先、その中は作成順)
   */
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
  /** 共通スキルの許可リスト。未指定 = 全可視、`[]` = すべて OFF (未指定のときはキーを省略する) */
  commonSkillNames: z.array(z.string()).optional(),
  /** 組み込みスキルの許可リスト。未指定 = 全部 ON、`[]` = すべて OFF (未指定のときはキーを省略する) */
  builtinSkillNames: z.array(z.string()).optional(),
  /**
   * 組み込みスキルを自然文で発火させるか。未指定 = 発火する (既定)。false のときだけキーを載せる。
   * セッション作成時のスナップショットで、定義を編集しても復元後の会話は変わらない
   */
  allowNaturalInvocationBuiltin: z.boolean().optional(),
  /** ファイルスキル (共通 / プロジェクト) 側の同じスナップショット値。false のときだけキーを載せる */
  allowNaturalInvocationFile: z.boolean().optional(),
  /**
   * ツールの許可リスト。未指定 = 全部 ON、`[]` = すべて OFF (未指定のときはキーを省略する)。
   * セッション作成時のスナップショットで、定義を編集しても復元後の会話は変わらない
   */
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
  /**
   * スコープ別の自然文発火。省略は現在値の維持、`null` は既定 (発火する) への解除で、2 キーは独立。
   */
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
  /**
   * 参照するマスタの ID (並び = 表示順)。未指定は現状維持、`[]` は全解除。
   * 未知・重複・上限超過は保存前に 400 で断り、部分保存しない。
   */
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
