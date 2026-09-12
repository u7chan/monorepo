/** DTO の正は server/src/schema.ts。ここは再配布だけで、hooks / components の import 先を保つ。 */
import type { EventEntry } from "server";

export type {
  AgentDef,
  AgentPayloadInfo,
  AgentSkillInfo,
  Catalog,
  ChatMessage,
  EventEntry,
  FileEntry,
  FileListing,
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

/** SSE イベント型名 (useSessionEvents の EVENT_TYPES 用に server の EventEntry から導出) */
export type SSEEventType = EventEntry["type"];
