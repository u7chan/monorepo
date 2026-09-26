/**
 * pi SDK の型が BFF の用途に合わない箇所を埋める互換層。SDK のイベント・SessionEntry・
 * AgentSession のうち BFF が使う分だけを写し、スタブや旧 SDK でも動くよう欠けたフィールドを許す。
 */
import type { AgentDef, AgentSkillInfo, ContextUsage, ModelRef, SkillDef, ThinkingLevel, Usage } from "./schema";
import type { PromptSnapshot } from "./session-store";
import { ContextUsageSchema, UsageSchema } from "./schema";

/** compaction_end の result (SDK の CompactionResult のうち BFF が控える分) */
export interface PiCompactionResult {
  estimatedTokensAfter?: unknown;
}

/** pi SDK から届くランタイムイベントの緩い形 (必要なフィールドのみ) */
export interface PiSessionEvent {
  type?: string;
  message?: { role?: string; usage?: unknown } | null;
  assistantMessageEvent?: { type?: string; delta?: string } | null;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  result?: unknown;
  attempt?: number;
  maxAttempts?: number;
  error?: unknown;
  willRetry?: boolean;
  reason?: string;
  aborted?: boolean;
  errorMessage?: string;
}

/** pi SDK の SessionEntry (BFF が compaction を読むのに必要な分だけ) */
export interface PiSessionEntryLike {
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  type?: unknown;
  message?: { role?: unknown; content?: unknown } | null;
  summary?: unknown;
  firstKeptEntryId?: unknown;
  tokensBefore?: unknown;
  usage?: unknown;
  fromHook?: unknown;
}

export type PiSessionEventListener = (event: PiSessionEvent) => void;

/** pi SDK の AgentSession を差し替え可能にするための最小 interface */
export interface PiSessionLike {
  sessionId: string;
  model?: { provider: string; id: string } | null;
  thinkingLevel?: string;
  messages: Array<{
    role: string;
    content: unknown;
    stopReason?: string;
    errorMessage?: string;
    timestamp?: number;
    usage?: unknown;
    /** role "toolResult" のとき: 対応する toolCall の id と成否 (スキル読み込みの導出に使う) */
    toolCallId?: string;
    isError?: boolean;
  }>;
  isStreaming: boolean;
  /** SDK の isIdle (実行・compaction・retry が無い) */
  isIdle: boolean;
  subscribe(listener: PiSessionEventListener): () => void;
  prompt(text: string): Promise<unknown>;
  abort(): Promise<unknown>;
  setModel(model: unknown, options?: { persist?: boolean }): Promise<void>;
  /** SDK の SessionManager。compaction の entry を読むためだけに参照する (旧 SDK では undefined) */
  sessionManager?: { getBranch?(): unknown[] };
  /** 手動 compaction。SDK が持たない実装 (スタブ・旧 SDK) では undefined */
  compact?(customInstructions?: string): Promise<unknown>;
  /**
   * 実行中の compaction を中断する。SDK の abort() も内部で呼ぶが、BFF は stop と同じ経路
   * (abort) を通すため単体では使わない。SDK が持たない実装では undefined
   */
  abortCompaction?(): void;
  /** SDK の isCompacting。BFF の保存待ちは含まない (busy 判定は SessionRecord の flag で行う) */
  isCompacting?: boolean;
  /** SDK が非対応値を補正する */
  setThinkingLevel(level: string, options?: { persist?: boolean }): void;
  /** 現在のモデルが選べる thinkingLevel (非推論モデルは ["off"] のみ) */
  getAvailableThinkingLevels(): string[];
  supportsThinking(): boolean;
  /** SDK が持たない実装 (スタブ・旧 SDK) では undefined を返してよい */
  getContextUsage?(): unknown;
  dispose?(): void;
  disposed?: boolean;
}

/** テストや埋め込み側が差し込む pi ランタイムの最小 interface */
export interface PiRuntimeLike {
  createSession(input?: {
    agent?: AgentDef;
    skills?: SkillDef[];
    model?: ModelRef;
    thinkingLevel?: ThinkingLevel;
    /** rootCwd 相対の作業ディレクトリ (省略・空文字は root)。BFF が絶対パスへ解決する */
    cwd?: string;
    /** 復元時: アプリのセッション ID */
    sessionId?: string;
    /** 復元時: JSONL から読んだ entries (header は含めない) */
    entries?: unknown[];
    /** 復元時: 作成時のプロンプトスナップショット */
    promptSnapshot?: PromptSnapshot;
    /** セッションのエージェントスナップショット (カタログスキルの説明の出所。復元でも渡す) */
    agentSkills?: AgentSkillInfo[];
  }): Promise<{ session: unknown; promptSnapshot?: PromptSnapshot }>;
  /** availableModels との厳密一致。スタブでは未実装でもよい */
  resolveModel?(model: ModelRef): unknown;
}

/** 旧 SDK は sessionManager を持たないため空配列へ落とす (compaction 履歴が無いものとして扱う) */
export function branchEntriesOf(session: PiSessionLike): PiSessionEntryLike[] {
  const entries = session.sessionManager?.getBranch?.();
  return Array.isArray(entries) ? (entries as PiSessionEntryLike[]) : [];
}

export function lastAssistantMessage(session: PiSessionLike): PiSessionLike["messages"][number] | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    if (session.messages[index].role === "assistant") return session.messages[index];
  }
  return undefined;
}

/** 契約外の usage (部分的な実装・旧 SDK) は数字として扱わず、キーごと落とす。 */
export function parseUsage(raw: unknown): Usage | undefined {
  const parsed = UsageSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function contextUsageOf(session: PiSessionLike): ContextUsage | undefined {
  const parsed = ContextUsageSchema.safeParse(session.getContextUsage?.());
  return parsed.success ? parsed.data : undefined;
}
