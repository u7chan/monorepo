/**
 * zod スキーマと API ペイロード型の正。
 * 正は client/src/types.ts (既存ミラー) と src/sessions.js の emit() 呼び出し。
 * DTO の JSON フィールド名は現行 JS と完全一致させること。
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 基本列挙 / 共通 DTO
// ---------------------------------------------------------------------------

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

export const AgentDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  skillIds: z.array(z.string()),
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

/**
 * health の DTO。client/src/types.ts の Health に加え、
 * ルート (GET /api/health) が返す拡張フィールドを optional で許容する。
 */
export const HealthSchema = z.object({
  cwd: z.string().optional(),
  ready: z.boolean(),
  model: z.string().optional(),
  error: z.string().optional(),
  ok: z.boolean().optional(),
  availableModels: z.array(z.string()).optional(),
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
// (catalog CRUD の body は zod で厳格化しない — agents 側の正規化ロジックが正)
// ---------------------------------------------------------------------------

export const PostMessageBodySchema = z.object({
  text: z.string(),
});
export type PostMessageBody = z.infer<typeof PostMessageBodySchema>;

export const CreateSessionBodySchema = z.object({
  agentId: z.string().optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

export const ReplaceCatalogBodySchema = z.object({
  agents: z.array(z.unknown()),
  skills: z.array(z.unknown()),
});
export type ReplaceCatalogBody = z.infer<typeof ReplaceCatalogBodySchema>;

// ---------------------------------------------------------------------------
// SSE イベント (src/sessions.js の emit 呼び出しを正とする)
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

/** 判別可能ユニオン: type で data を絞り込める */
export type EventEntry = {
  [T in SSEEventType]: EventEntryFor<T>;
}[SSEEventType];
