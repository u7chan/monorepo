/** DTO の正は server/src/schema.ts。ここは再配布だけで、hooks / components の import 先を保つ。 */
import type { EventEntry } from "server";

export type {
  AgentDef,
  AgentPayloadInfo,
  AgentSkillInfo,
  AgentSuggestion,
  Catalog,
  ChatMessage,
  CompactionInfo,
  CompactionReason,
  ContextUsage,
  CreateAgentBody,
  CreateSkillBody,
  EventEntry,
  FileEntry,
  FileListing,
  FilePreview,
  Health,
  MessageMetrics,
  ModelOption,
  ModelRef,
  PostMessageResult,
  Project,
  ProjectsResponse,
  RunPayload,
  RunStatus,
  SessionPayload,
  SessionSummary,
  SkillDef,
  StopResult,
  ThinkingLevel,
  ToolCall,
  UpdateAgentBody,
  UpdateSkillBody,
  Usage,
} from "server";

/** SSE イベント型名 (useSessionEvents の EVENT_TYPES 用に server の EventEntry から導出) */
export type SSEEventType = EventEntry["type"];
