/** API 契約の正。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";

export const RunStatusSchema = z.enum([
  "idle",
  "running",
  "queued",
  "completed",
  "stopped",
  "error",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const SkillDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
});
export type SkillDef = z.infer<typeof SkillDefSchema>;

/** pi SDK の thinkingLevel。UI では「Effort」と表示する。 */
export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** 認証済みモデルの provider/id 参照 (SDK の Model そのものではない) */
export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const AgentDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  skillIds: z.array(z.string()),
  // 未指定のときはキー自体を省略する (null は保存・応答に現れない)
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});
export type AgentDef = z.infer<typeof AgentDefSchema>;

export const CatalogSchema = z.object({
  agents: z.array(AgentDefSchema),
  skills: z.array(SkillDefSchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;

export const AgentSkillInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type AgentSkillInfo = z.infer<typeof AgentSkillInfoSchema>;

export const AgentPayloadInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  skillIds: z.array(z.string()),
  skills: z.array(AgentSkillInfoSchema),
});
export type AgentPayloadInfo = z.infer<typeof AgentPayloadInfoSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.string(),
  isError: z.boolean(),
  done: z.boolean(),
  output: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const RunPayloadSchema = z.object({
  id: z.string(),
  status: RunStatusSchema,
  startedAt: z.number(),
  endedAt: z.number().optional(),
  error: z.string().optional(),
  prompt: z.string(),
  toolCalls: z.array(ToolCallSchema),
});
export type RunPayload = z.infer<typeof RunPayloadSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  stopReason: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const SessionPayloadSchema = z.object({
  sessionId: z.string(),
  piSessionId: z.string(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: z.string().optional(),
  /** 実効モデルが推論に対応しているか (SDK の supportsThinking 相当) */
  supportsThinking: z.boolean().optional(),
  /** 実効モデルが選べる thinkingLevel (非推論モデルは ["off"] のみ) */
  availableThinkingLevels: z.array(ThinkingLevelSchema).optional(),
  status: RunStatusSchema,
  title: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  queueDepth: z.number(),
  lastSeq: z.number(),
  agent: AgentPayloadInfoSchema.optional(),
  run: RunPayloadSchema.nullable(),
  messages: z.array(ChatMessageSchema),
});
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  agentId: z.string(),
  agentName: z.string().optional(),
  status: RunStatusSchema,
  queueDepth: z.number(),
  messageCount: z.number(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  model: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** モデル選択肢。server が SDK から解決して health で返す。 */
export const ModelOptionSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  supportsThinking: z.boolean(),
  thinkingLevels: z.array(ThinkingLevelSchema),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

/** client/src/types.ts の Health に加え、ルート固有のフィールドを optional で許容する。 */
export const HealthSchema = z.object({
  cwd: z.string().optional(),
  ready: z.boolean(),
  model: z.string().optional(),
  error: z.string().optional(),
  errorCode: z.enum(["authentication_required", "model_whitelist_empty", "runtime_unavailable"]).optional(),
  ok: z.boolean().optional(),
  availableModels: z.array(z.string()).optional(),
  modelOptions: z.array(ModelOptionSchema).optional(),
  /** アプリ既定の thinkingLevel */
  defaultThinkingLevel: ThinkingLevelSchema.optional(),
  /** 明示 PI_MODEL が利用不能なときの理由 (ready は true のまま) */
  defaultModelError: z.string().optional(),
  tools: z.array(z.string()).optional(),
  availabilityError: z.string().optional(),
});
export type Health = z.infer<typeof HealthSchema>;

export const PostMessageResultSchema = z.object({
  queued: z.boolean(),
  queueDepth: z.number(),
  runId: z.string().optional(),
});
export type PostMessageResult = z.infer<typeof PostMessageResultSchema>;

export const StopResultSchema = z.object({
  ok: z.literal(true),
  status: RunStatusSchema,
});
export type StopResult = z.infer<typeof StopResultSchema>;

// ---------------------------------------------------------------------------
// リクエスト body スキーマ
// catalog CRUD の body は zod で厳格化しない (agents 側の正規化ロジックが正)
// ---------------------------------------------------------------------------

export const PostMessageBodySchema = z.object({
  text: z.string(),
});
export type PostMessageBody = z.infer<typeof PostMessageBodySchema>;

export const CreateSessionBodySchema = z.object({
  agentId: z.string().optional(),
  // 未指定ならエージェント定義 → アプリ既定の順に解決する (null は 400)
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

/** チャット設定変更。省略は現在値維持、null・空 body は 400 */
export const UpdateSessionSettingsBodySchema = z.object({
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});
export type UpdateSessionSettingsBody = z.infer<typeof UpdateSessionSettingsBodySchema>;

export const ReplaceCatalogBodySchema = z.object({
  agents: z.array(z.unknown()),
  skills: z.array(z.unknown()),
});
export type ReplaceCatalogBody = z.infer<typeof ReplaceCatalogBodySchema>;

// ---------------------------------------------------------------------------
// SSE イベント (sessions.ts の emit 呼び出しを正とする)
// ---------------------------------------------------------------------------

export const EventDataSchemas = {
  run_start: z.object({ runId: z.string(), prompt: z.string() }),
  text: z.object({ delta: z.string() }),
  tool_start: z.object({ id: z.string(), name: z.string(), args: z.string() }),
  tool_end: z.object({
    id: z.string(),
    name: z.string().optional(),
    isError: z.boolean(),
    output: z.string(),
  }),
  status: z.object({ state: z.string(), text: z.string() }),
  queued: z.object({
    position: z.number(),
    queueDepth: z.number(),
    prompt: z.string(),
  }),
  queue_cleared: z.object({}).strict(),
  run_end: z.object({
    runId: z.string().optional(),
    status: RunStatusSchema,
    queueDepth: z.number(),
    error: z.string().optional(),
    messageCount: z.number().optional(),
  }),
  resync: SessionPayloadSchema,
  session_deleted: z.object({ sessionId: z.string() }),
} as const;

export type SSEEventType = keyof typeof EventDataSchemas;

export type SSEEventData = {
  [T in SSEEventType]: z.infer<(typeof EventDataSchemas)[T]>;
};

type EventEntryFor<T extends SSEEventType> = {
  seq: number;
  type: T;
  data: SSEEventData[T];
  at: number;
};

/** type で data を絞り込める判別可能ユニオン */
export type EventEntry = {
  [T in SSEEventType]: EventEntryFor<T>;
}[SSEEventType];
