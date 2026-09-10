/**
 * 実行ライフサイクル全体を保有するインメモリセッションストア。
 *
 * 「ラン」(pi セッションへの 1 回の prompt() 呼び出し) はバックグラウンドで
 * 始まり、HTTP リクエストとは決して結びつかない: クライアントは入れ替わり、
 * ランは走り続ける。すべてのイベントは単調増加のシーケンス番号付きで
 * セッションごとのログに追記され、購読者はランの途中で参加・再接続して
 * 見逃した分をリプレイできる。ラン中に投稿されたメッセージはキューに入り、
 * 順番に実行される。停止は実行中のランを中断し、キューを空にする。
 * port 元: src/sessions.js
 */
import { randomUUID } from "node:crypto";
import { AUTH_REQUIRED_MESSAGE, type PiBff } from "./agent";
import type { AgentCatalog } from "./agents";
import type {
  AgentDef,
  AgentSkillInfo,
  ChatMessage,
  EventEntry,
  RunStatus,
  SessionPayload,
  SessionSummary,
  SSEEventType,
  SSEEventData,
  SkillDef,
  ToolCall,
} from "./schema";

const MAX_EVENT_LOG = 2000;
const MAX_QUEUE_DEPTH = 10;
const QUEUE_DELAY_MS = 200;
const SESSION_TTL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const TITLE_MAX = 60;
const SUMMARY_TEXT_MAX = 900;
const ARGS_TEXT_MAX = 260;
const PROMPT_TEXT_MAX = 300;

export const MAX_MESSAGE_CHARS = 8000;

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function userFacingError(error: unknown): string {
  const message = messageFor(error);
  if (/No API key found|Provider is not configured|No model selected/i.test(message)) {
    return AUTH_REQUIRED_MESSAGE;
  }
  return message;
}

export interface HttpLikeError extends Error {
  statusCode?: number;
}

function truncate(value: string | undefined | null, length: number): string {
  if (!value) return "";
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => (part as { text: string }).text)
    .join("");
}

function toolArgsSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") return `$ ${truncate(record.command, ARGS_TEXT_MAX)}`;
  const path = record.path || record.file_path || record.filePath;
  if (typeof path === "string") return path;
  try {
    return truncate(JSON.stringify(args), ARGS_TEXT_MAX);
  } catch {
    return "";
  }
}

function toolResultSummary(result: unknown): string {
  return truncate(contentText((result as { content?: unknown } | null)?.content), SUMMARY_TEXT_MAX);
}

function modelLabel(model?: { provider: string; id: string } | null): string | undefined {
  if (!model || (model.provider === "unknown" && model.id === "unknown")) return undefined;
  return `${model.provider}/${model.id}`;
}

// ---------------------------------------------------------------------------
// pi SDK セッションの最小 interface (pi SDK 側に都合のよい型がないため)
// ---------------------------------------------------------------------------

/** pi SDK から届くランタイムイベントの緩い形 (必要なフィールドのみ) */
export interface PiSessionEvent {
  type?: string;
  message?: { role?: string } | null;
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
}

export type PiSessionEventListener = (event: PiSessionEvent) => void;

/** pi SDK の AgentSession を差し替え可能にするための最小 interface */
export interface PiSessionLike {
  sessionId: string;
  model?: { provider: string; id: string } | null;
  thinkingLevel?: string;
  messages: Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string }>;
  isStreaming: boolean;
  subscribe(listener: PiSessionEventListener): () => void;
  prompt(text: string): Promise<unknown>;
  abort(): Promise<unknown>;
  dispose?(): void;
  disposed?: boolean;
  sessionManager?: { getCwd?(): string } | null;
}

/** テストや埋め込み側が差し込む pi ランタイムの最小 interface */
export interface PiRuntimeLike {
  createSession(input?: { agent?: AgentDef; skills?: SkillDef[] }): Promise<{ session: unknown }>;
}

export interface RunState {
  id: string;
  prompt: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface SessionSubscriber {
  send: (entry: EventEntry) => void;
  close?: () => void;
}

export interface SessionRecord {
  id: string;
  session: PiSessionLike;
  agentId: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  seq: number;
  events: EventEntry[];
  subscribers: Set<SessionSubscriber>;
  queue: string[];
  run: RunState | null;
  tools: Map<string, ToolCall>;
}

export interface CreateSessionOptions {
  agentId?: string;
}

export interface PostMessageResultInternal {
  queued: boolean;
  queueDepth: number;
  runId?: string;
}

function lastAssistantMessage(session: PiSessionLike) {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    if (session.messages[index].role === "assistant") return session.messages[index];
  }
  return undefined;
}

function sessionMessages(session: PiSessionLike): ChatMessage[] {
  return session.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = contentText(message.content);
      return {
        role: message.role as "user" | "assistant",
        text,
        stopReason: message.role === "assistant" ? message.stopReason : undefined,
      };
    })
    .filter((message) => message.text || message.role === "user");
}

export class SessionStore {
  pi: PiRuntimeLike | null;
  catalog: AgentCatalog;
  records: Map<string, SessionRecord>;
  sweeper: ReturnType<typeof setInterval>;

  constructor({ pi, catalog }: { pi?: PiRuntimeLike | null; catalog?: AgentCatalog } = {}) {
    if (!catalog) throw new Error("SessionStore requires an agent catalog");
    this.pi = pi || null;
    this.catalog = catalog;
    this.records = new Map();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  get size(): number {
    return this.records.size;
  }

  async create({ agentId }: CreateSessionOptions = {}): Promise<SessionRecord> {
    if (!this.pi) {
      const error = new Error("Pi runtime is not ready") as HttpLikeError;
      error.statusCode = 503;
      throw error;
    }
    const selectedAgentId = agentId || this.catalog.listAgents()[0]?.id;
    const agent = selectedAgentId ? this.catalog.getAgent(selectedAgentId) : undefined;
    if (!agent) {
      const error = new Error("Agent not found") as HttpLikeError;
      error.statusCode = 400;
      throw error;
    }
    const skills = agent.skillIds
      .map((skillId) => this.catalog.getSkill(skillId))
      .filter((skill): skill is SkillDef => Boolean(skill));
    const { session } = await this.pi.createSession({ agent, skills });
    const record: SessionRecord = {
      id: randomUUID(),
      session: session as PiSessionLike,
      agentId: agent.id,
      title: "",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      seq: 0,
      events: [],
      subscribers: new Set(),
      queue: [],
      run: null,
      tools: new Map(),
    };
    this.records.set(record.id, record);
    return record;
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  list(): SessionSummary[] {
    return [...this.records.values()]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map((record) => this.summary(record));
  }

  statusOf(record: SessionRecord): RunStatus {
    if (record.run?.status === "running" || record.session.isStreaming) return "running";
    if (record.queue.length > 0) return "queued";
    return record.run?.status || "idle";
  }

  isBusy(record: SessionRecord): boolean {
    return this.statusOf(record) === "running" || this.statusOf(record) === "queued";
  }

  /**
   * ユーザーメッセージをセッションに渡す。即座にバックグラウンドランを
   * 始めるか、ランが既に動いていればメッセージをキューに追加する。
   */
  postMessage(record: SessionRecord, text: string): PostMessageResultInternal {
    if (this.statusOf(record) === "running" || record.session.isStreaming) {
      if (record.queue.length >= MAX_QUEUE_DEPTH) {
        const error = new Error(`Message queue is full (max ${MAX_QUEUE_DEPTH})`) as HttpLikeError;
        error.statusCode = 429;
        throw error;
      }
    }
    if (!record.title) record.title = truncate(text.replace(/\s+/g, " ").trim(), TITLE_MAX);
    record.lastUsedAt = Date.now();

    if (record.run?.status === "running" || record.session.isStreaming) {
      record.queue.push(text);
      this.emit(record, "queued", {
        position: record.queue.length,
        queueDepth: record.queue.length,
        prompt: text,
      });
      return { queued: true, queueDepth: record.queue.length, runId: record.run?.id };
    }

    const run = this.startRun(record, text);
    return { queued: false, queueDepth: 0, runId: run.id };
  }

  /** 実行中のランを明示的に止め、キューに積まれたメッセージを捨てる。 */
  async stop(record: SessionRecord): Promise<{ ok: true; status: RunStatus }> {
    record.lastUsedAt = Date.now();
    if (record.queue.length > 0) {
      record.queue = [];
      this.emit(record, "queue_cleared", {});
    }
    if (record.run?.status === "running" || record.session.isStreaming) {
      await record.session.abort().catch(() => {});
    }
    return { ok: true, status: this.statusOf(record) };
  }

  /**
   * セッションのイベントログを購読する。`after` はクライアントが最後に
   * 見たシーケンス番号で、それより後のバッファ済みエントリをリプレイする。
   * クライアントがバッファより大きく遅れている場合は、セッション全文を
   * 持った単一の `resync` イベントを代わりに送る。
   */
  subscribe(
    record: SessionRecord,
    after: number | undefined,
    send: (entry: EventEntry) => void,
    close?: () => void,
  ): () => void {
    const subscriber: SessionSubscriber = { send, close };
    record.subscribers.add(subscriber);
    const cursor = after !== undefined && Number.isInteger(after) && after >= 0 ? after : record.seq;
    const earliest = record.events.length > 0 ? record.events[0].seq : record.seq + 1;
    if (cursor + 1 < earliest) {
      send({ seq: record.seq, type: "resync", data: this.payload(record), at: Date.now() });
    } else {
      for (const entry of record.events) {
        if (entry.seq > cursor) send(entry);
      }
    }
    return () => record.subscribers.delete(subscriber);
  }

  payload(record: SessionRecord): SessionPayload {
    const { session } = record;
    const agent = this.catalog.getAgent(record.agentId);
    return {
      sessionId: record.id,
      piSessionId: session.sessionId,
      cwd: session.sessionManager?.getCwd?.(),
      model: modelLabel(session.model),
      thinkingLevel: session.thinkingLevel,
      status: this.statusOf(record),
      title: record.title,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      queueDepth: record.queue.length,
      lastSeq: record.seq,
      agent: agent
        ? {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            skillIds: [...agent.skillIds],
            skills: agent.skillIds
              .map((skillId) => this.catalog.getSkill(skillId))
              .filter((skill): skill is SkillDef => Boolean(skill))
              .map((skill): AgentSkillInfo => ({ id: skill.id, name: skill.name, description: skill.description })),
          }
        : undefined,
      run: record.run
        ? {
            id: record.run.id,
            status: record.run.status,
            startedAt: record.run.startedAt,
            endedAt: record.run.endedAt,
            error: record.run.error,
            prompt: truncate(record.run.prompt, PROMPT_TEXT_MAX),
            toolCalls: [...record.tools.values()],
          }
        : null,
      messages: sessionMessages(session),
    };
  }

  summary(record: SessionRecord): SessionSummary {
    const agent = this.catalog.getAgent(record.agentId);
    return {
      sessionId: record.id,
      title: record.title || "無題のセッション",
      agentId: record.agentId,
      agentName: agent?.name,
      status: this.statusOf(record),
      queueDepth: record.queue.length,
      messageCount: sessionMessages(record.session).length,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      model: modelLabel(record.session.model),
    };
  }

  async destroy(record: SessionRecord): Promise<void> {
    if (record.run?.status === "running" || record.session.isStreaming) {
      await record.session.abort().catch(() => {});
    }
    record.session.dispose?.();
    this.records.delete(record.id);
    const subscribers = [...record.subscribers];
    record.subscribers.clear();
    for (const subscriber of subscribers) {
      try {
        subscriber.send({
          seq: record.seq + 1,
          type: "session_deleted",
          data: { sessionId: record.id },
          at: Date.now(),
        });
      } catch {
        // subscriber already gone
      }
      try {
        subscriber.close?.();
      } catch {
        // ignore
      }
    }
  }

  sweep(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, record] of this.records) {
      if (!this.isBusy(record) && record.lastUsedAt < cutoff) {
        record.session.dispose?.();
        this.records.delete(id);
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    for (const record of this.records.values()) {
      if (this.isBusy(record)) await record.session.abort().catch(() => {});
      record.session.dispose?.();
    }
    this.records.clear();
  }

  /** バックグラウンドランを開始する。呼び出し側はセッションが idle であること。 */
  startRun(record: SessionRecord, text: string): RunState {
    const { session } = record;
    const run: RunState = {
      id: randomUUID(),
      prompt: text,
      status: "running",
      startedAt: Date.now(),
      endedAt: undefined,
      error: undefined,
    };
    record.run = run;
    record.tools = new Map();
    record.lastUsedAt = Date.now();
    this.emit(record, "run_start", { runId: run.id, prompt: text });

    let finished = false;
    let currentAssistantText = "";

    const finish = ({ error, stopped = false }: { error?: string; stopped?: boolean } = {}): void => {
      if (finished) return;
      finished = true;

      // プロバイダは通常 text delta をストリームする。このフォールバックは
      // message_end で初めて最終テキストを含めるプロバイダも支援する。
      const finalAssistant = lastAssistantMessage(session);
      const finalText = contentText(finalAssistant?.content);
      if (finalText && !currentAssistantText) {
        this.emit(record, "text", { delta: finalText });
      } else if (finalText && currentAssistantText && finalText.startsWith(currentAssistantText)) {
        const remainder = finalText.slice(currentAssistantText.length);
        if (remainder) this.emit(record, "text", { delta: remainder });
      }

      run.status = stopped ? "stopped" : error ? "error" : "completed";
      run.endedAt = Date.now();
      if (error) run.error = error;
      this.emit(record, "run_end", {
        runId: run.id,
        status: run.status,
        error: run.error,
        messageCount: session.messages.length,
        queueDepth: record.queue.length,
      });

      if (record.queue.length > 0) {
        setTimeout(() => this.pump(record), QUEUE_DELAY_MS).unref?.();
      }
    };

    const onEvent: PiSessionEventListener = (event) => {
      if (finished) return;
      try {
        switch (event.type) {
          case "agent_start":
            this.emit(record, "status", { state: "thinking", text: "考え中…" });
            break;
          case "message_start":
            if (event.message?.role === "assistant") currentAssistantText = "";
            break;
          case "message_update":
            if (event.assistantMessageEvent?.type === "text_delta") {
              currentAssistantText += event.assistantMessageEvent.delta ?? "";
              this.emit(record, "text", { delta: event.assistantMessageEvent.delta ?? "" });
            }
            break;
          case "tool_execution_start": {
            const tool: ToolCall = {
              id: event.toolCallId ?? "",
              name: event.toolName ?? "",
              args: toolArgsSummary(event.args),
              isError: false,
              done: false,
              output: "",
            };
            record.tools.set(tool.id, tool);
            this.emit(record, "tool_start", { id: tool.id, name: tool.name, args: tool.args });
            this.emit(record, "status", { state: "tool", text: `${tool.name} を実行中…` });
            break;
          }
          case "tool_execution_end": {
            const tool = record.tools.get(event.toolCallId ?? "");
            if (tool) {
              tool.done = true;
              tool.isError = Boolean(event.isError);
              tool.output = toolResultSummary(event.result);
            }
            this.emit(record, "tool_end", {
              id: event.toolCallId ?? "",
              name: event.toolName ?? "",
              isError: Boolean(event.isError),
              output: toolResultSummary(event.result),
            });
            break;
          }
          case "compaction_start":
            this.emit(record, "status", { state: "compacting", text: "会話を整理中…" });
            break;
          case "auto_retry_start":
            this.emit(record, "status", {
              state: "retry",
              text: `再試行中… (${event.attempt}/${event.maxAttempts})`,
            });
            break;
          case "extension_error":
            this.emit(record, "status", {
              state: "warning",
              text: typeof event.error === "string" ? event.error : String(event.error ?? ""),
            });
            break;
          case "agent_end":
            if (event.willRetry) {
              this.emit(record, "status", { state: "retry", text: "再試行を準備中…" });
            }
            break;
          case "agent_settled": {
            const finalAssistant = lastAssistantMessage(session);
            const runError = finalAssistant?.stopReason === "error"
              ? userFacingError(finalAssistant.errorMessage || "モデルの実行に失敗しました")
              : undefined;
            finish({ error: runError, stopped: finalAssistant?.stopReason === "aborted" });
            break;
          }
          default:
            break;
        }
      } catch (error) {
        finish({ error: userFacingError(error) });
      }
    };

    const unsubscribe = session.subscribe(onEvent);
    session.prompt(text).then(() => {
      // agent_settled は prompt() の解決より先に届くはず。カスタムプロバイダや
      // 未来の SDK 変更に備えたフォールバック。
      if (!finished) finish();
      unsubscribe();
    }).catch((error) => {
      if (!finished) finish({ error: userFacingError(error) });
      unsubscribe();
    });

    return run;
  }

  /** キューに次があれば実行する。 */
  pump(record: SessionRecord): void {
    if (record.queue.length === 0) return;
    if (record.run?.status === "running" || record.session.isStreaming) return;
    const next = record.queue.shift();
    if (next === undefined) return;
    record.lastUsedAt = Date.now();
    this.startRun(record, next);
  }

  emit<T extends SSEEventType>(record: SessionRecord, type: T, data: SSEEventData[T]): EventEntry {
    record.seq += 1;
    const entry = { seq: record.seq, type, data, at: Date.now() } as EventEntry;
    record.events.push(entry);
    if (record.events.length > MAX_EVENT_LOG) {
      record.events.splice(0, record.events.length - MAX_EVENT_LOG);
    }
    for (const subscriber of [...record.subscribers]) {
      try {
        subscriber.send(entry);
      } catch {
        record.subscribers.delete(subscriber);
      }
    }
    return entry;
  }
}

/** 互換用の再エクスポート (PiBff は pi ランタイム実装として扱える) */
export type PiRuntime = PiBff;
