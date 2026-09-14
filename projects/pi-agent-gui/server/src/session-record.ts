/**
 * セッション 1 件分の状態の形。生成・破棄・競合制御は SessionStore が持ち、
 * projection はこの型を読み取り専用の入力として受け取る。
 */
import type {
  AgentPayloadInfo,
  CompactionReason,
  EventEntry,
  MessageMetrics,
  ModelRef,
  RunStatus,
  ThinkingLevel,
  ToolCall,
} from "./schema";
import type { PiSessionLike } from "./pi-runtime";

export interface RunState {
  id: string;
  prompt: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

/** compaction entry id に紐づく、entry へは保存されない表示用の値 */
export interface CompactionMeta {
  reason?: CompactionReason;
  estimatedTokensAfter?: number;
}

export interface SessionSubscriber {
  send: (entry: EventEntry) => void;
  close?: () => void;
}

export interface SessionRecord {
  id: string;
  session: PiSessionLike;
  agentId: string;
  projectId?: string;
  /** 作成時点のスナップショット (定義の編集・削除の影響を受けない) */
  agent: AgentPayloadInfo;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  seq: number;
  events: EventEntry[];
  subscribers: Set<SessionSubscriber>;
  queue: string[];
  run: RunState | null;
  tools: Map<string, ToolCall>;
  /** SDK のメッセージオブジェクト -> BFF 計測の応答時間 (履歴へ写すときに同じ参照で引く) */
  messageMetrics: WeakMap<object, MessageMetrics>;
  /** compaction entry id -> entry に保存されない表示用の値 (compaction_end 受信時に控える) */
  compactionMeta: Map<string, CompactionMeta>;
  /** 設定変更中フラグ。非同期 setModel の間、送信と二重変更を 409 で拒否する */
  changingSettings: boolean;
}

export interface CreateSessionOptions {
  agentId?: string;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  projectId?: string;
}

export interface UpdateSessionSettingsInput {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
}

export interface PostMessageResultInternal {
  queued: boolean;
  queueDepth: number;
  runId?: string;
}
