/**
 * API ペイロード型。
 * DTO の正は server/src/schema.ts (zod スキーマ + z.infer) のため、ここでは server から再配布するのみ。
 * hooks/components は従来どおり "../types" から import できる (型名は不変)。
 */
import type { EventEntry } from "server";

export type {
  AgentDef,
  AgentPayloadInfo,
  AgentSkillInfo,
  Catalog,
  ChatMessage,
  EventEntry,
  Health,
  ModelOption,
  ModelRef,
  PostMessageResult,
  RunPayload,
  RunStatus,
  SessionPayload,
  SessionSummary,
  SkillDef,
  StopResult,
  ThinkingLevel,
  ToolCall,
} from "server";

/** SSE イベント型名の一覧。useSessionEvents の EVENT_TYPES 用 (server の EventEntry から導出) */
export type SSEEventType = EventEntry["type"];
