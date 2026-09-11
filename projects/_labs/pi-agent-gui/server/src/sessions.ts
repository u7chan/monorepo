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
import { createSecretMasker, createStreamingSecretMasker, type SecretMasker } from "./redact";
import type { AgentCatalog } from "./agents";
import type {
  AgentDef,
  AgentPayloadInfo,
  AgentSkillInfo,
  ChatMessage,
  EventEntry,
  ModelRef,
  RunStatus,
  SessionPayload,
  SessionSummary,
  SSEEventType,
  SSEEventData,
  SkillDef,
  ThinkingLevel,
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

function httpError(statusCode: number, message: string): HttpLikeError {
  const error = new Error(message) as HttpLikeError;
  error.statusCode = statusCode;
  return error;
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
  /** SDK の isIdle (実行・compaction・retry が無い) */
  isIdle: boolean;
  subscribe(listener: PiSessionEventListener): () => void;
  prompt(text: string): Promise<unknown>;
  abort(): Promise<unknown>;
  /** モデル変更。SDK は認証確認後にモデルと thinking を切り替える */
  setModel(model: unknown, options?: { persist?: boolean }): Promise<void>;
  /** thinkingLevel 変更。SDK が非対応値を補正する */
  setThinkingLevel(level: string, options?: { persist?: boolean }): void;
  /** 現在のモデルが選べる thinkingLevel (非推論モデルは ["off"] のみ) */
  getAvailableThinkingLevels(): string[];
  supportsThinking(): boolean;
  dispose?(): void;
  disposed?: boolean;
  sessionManager?: { getCwd?(): string } | null;
}

/** テストや埋め込み側が差し込む pi ランタイムの最小 interface */
export interface PiRuntimeLike {
  createSession(input?: {
    agent?: AgentDef;
    skills?: SkillDef[];
    model?: ModelRef;
    thinkingLevel?: ThinkingLevel;
  }): Promise<{ session: unknown }>;
  /** availableModels との厳密一致。未実装のスタブでは未定義を返す */
  resolveModel?(model: ModelRef): unknown;
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
  /** 作成時点のエージェント表示情報 (定義の編集・削除の影響を受けないスナップショット) */
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
  /** 設定変更中フラグ。非同期 setModel の間、送信と二重変更を 409 で拒否する */
  changingSettings: boolean;
}

export interface CreateSessionOptions {
  agentId?: string;
  /** 作成時のチャット指定 (未指定ならエージェント定義 → アプリ既定) */
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
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

function lastAssistantMessage(session: PiSessionLike) {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    if (session.messages[index].role === "assistant") return session.messages[index];
  }
  return undefined;
}

function sessionMessages(session: PiSessionLike, masker: SecretMasker): ChatMessage[] {
  return session.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = masker.mask(contentText(message.content));
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
  /** SSE / ログへ出すテキストから既知の秘密値を除く (保護対象が無ければ素通し) */
  masker: SecretMasker;
  records: Map<string, SessionRecord>;
  sweeper: ReturnType<typeof setInterval>;

  constructor({
    pi,
    catalog,
    masker,
  }: {
    pi?: PiRuntimeLike | null;
    catalog?: AgentCatalog;
    masker?: SecretMasker | null;
  } = {}) {
    if (!catalog) throw new Error("SessionStore requires an agent catalog");
    this.pi = pi || null;
    this.catalog = catalog;
    this.masker = masker ?? createSecretMasker([]);
    this.records = new Map();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  get size(): number {
    return this.records.size;
  }

  async create({ agentId, model, thinkingLevel }: CreateSessionOptions = {}): Promise<SessionRecord> {
    if (!this.pi) {
      const error = new Error("ランタイムを利用できません") as HttpLikeError;
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
    // 表示に必要なエージェント情報は作成時にスナップショット化する
    // (定義の編集・インポートを既存チャットに遡及させない)。
    const agentInfo: AgentPayloadInfo = {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      skillIds: [...agent.skillIds],
      skills: skills.map((skill): AgentSkillInfo => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
      })),
    };
    // 項目別に「作成時のチャット指定 → エージェント定義」を解決する。
    // どちらも未指定ならランタイム側のアプリ既定に委ねる。
    const { session } = await this.pi.createSession({
      agent: { ...agent, skillIds: [...agent.skillIds] },
      skills,
      model: model ?? agent.model,
      thinkingLevel: thinkingLevel ?? agent.thinkingLevel,
    });
    const record: SessionRecord = {
      id: randomUUID(),
      session: session as PiSessionLike,
      agentId: agent.id,
      agent: agentInfo,
      title: "",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      seq: 0,
      events: [],
      subscribers: new Set(),
      queue: [],
      run: null,
      tools: new Map(),
      changingSettings: false,
    };
    this.records.set(record.id, record);
    return record;
  }

  /**
   * チャット単位のモデル・Effort 変更。同じ SDK セッション・履歴・タイトルを保つ。
   * 実行中・キューあり・SDK 非 idle・別の設定変更中は 409。
   */
  async updateSettings(
    record: SessionRecord,
    input: UpdateSessionSettingsInput,
  ): Promise<SessionPayload> {
    if (
      this.isBusy(record) ||
      record.session.isStreaming ||
      record.session.isIdle === false ||
      record.changingSettings
    ) {
      throw httpError(409, "Session settings cannot be changed while the session is busy");
    }
    if (!this.pi) {
      const error = new Error("ランタイムを利用できません") as HttpLikeError;
      error.statusCode = 503;
      throw error;
    }

    // モデルは作成時と同様に available へ厳密照合する (暗黙 fallback しない)
    const modelObject = input.model ? this.pi.resolveModel?.(input.model) : undefined;
    if (input.model && !modelObject) {
      throw httpError(400, `Model is not available: ${input.model.provider}/${input.model.id}`);
    }
    const { session } = record;
    // 変更開始前にフラグを同期的に予約する。以降の送信・二重変更は 409 になる。
    record.changingSettings = true;
    try {
      if (input.model) {
        // モデルだけ変更する場合は現在の実効 Effort を退避し、SDK 切替後に再適用する。
        // 両方指定時は要求 Effort を再適用する。SDK が非対応値を補正する。
        const previousThinking = session.thinkingLevel;
        await session.setModel(modelObject, { persist: false });
        session.setThinkingLevel(input.thinkingLevel ?? previousThinking ?? "medium", { persist: false });
      } else if (input.thinkingLevel) {
        session.setThinkingLevel(input.thinkingLevel, { persist: false });
      }
    } finally {
      record.changingSettings = false;
    }

    record.lastUsedAt = Date.now();
    // 実効値 (SDK 補正後) を正として購読中の全クライアントへ同期する
    return this.emitResync(record);
  }

  /** resync イベントを記録し、そのイベントと同じ lastSeq を持つ payload を返す */
  emitResync(record: SessionRecord): SessionPayload {
    const payload = this.payload(record);
    payload.lastSeq = record.seq + 1;
    this.emit(record, "resync", payload);
    return payload;
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
    // 設定変更中は送信も待たせる (BFF 側でも拒否する)
    if (record.changingSettings) {
      throw httpError(409, "Session settings are being changed");
    }
    if (this.statusOf(record) === "running" || record.session.isStreaming) {
      if (record.queue.length >= MAX_QUEUE_DEPTH) {
        const error = new Error(`Message queue is full (max ${MAX_QUEUE_DEPTH})`) as HttpLikeError;
        error.statusCode = 429;
        throw error;
      }
    }
    if (!record.title) {
      record.title = truncate(this.masker.mask(text).replace(/\s+/g, " ").trim(), TITLE_MAX);
    }
    record.lastUsedAt = Date.now();

    if (record.run?.status === "running" || record.session.isStreaming) {
      record.queue.push(text);
      this.emit(record, "queued", {
        position: record.queue.length,
        queueDepth: record.queue.length,
        prompt: this.masker.mask(text),
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
    const availableThinkingLevels = (session.getAvailableThinkingLevels() ??
      (session.thinkingLevel ? [session.thinkingLevel] : [])) as ThinkingLevel[];
    return {
      sessionId: record.id,
      piSessionId: session.sessionId,
      cwd: session.sessionManager?.getCwd?.(),
      model: modelLabel(session.model),
      thinkingLevel: session.thinkingLevel,
      supportsThinking: session.supportsThinking(),
      availableThinkingLevels,
      status: this.statusOf(record),
      title: record.title,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      queueDepth: record.queue.length,
      lastSeq: record.seq,
      agent: {
        ...record.agent,
        skillIds: [...record.agent.skillIds],
        skills: record.agent.skills.map((skill) => ({ ...skill })),
      },
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
      messages: sessionMessages(session, this.masker),
    };
  }

  summary(record: SessionRecord): SessionSummary {
    return {
      sessionId: record.id,
      title: record.title || "無題のセッション",
      agentId: record.agentId,
      agentName: record.agent.name,
      status: this.statusOf(record),
      queueDepth: record.queue.length,
      messageCount: sessionMessages(record.session, this.masker).length,
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
      // ログ・SSE用に保持するプロンプトはマスクする。モデルへ渡す text は
      // ユーザー入力そのままだ (ユーザー自身が貼ったキーは対象外)。
      prompt: this.masker.mask(text),
      status: "running",
      startedAt: Date.now(),
      endedAt: undefined,
      error: undefined,
    };
    record.run = run;
    record.tools = new Map();
    record.lastUsedAt = Date.now();
    this.emit(record, "run_start", { runId: run.id, prompt: run.prompt });

    let finished = false;
    let currentAssistantText = "";
    // 差分をそのまま配信せず、秘密値の前方一致になり得る末尾を保留する。
    // アシスタントメッセージが替わるたびに作り直す。
    let deltaMasker = createStreamingSecretMasker(this.masker);

    const finish = ({ error, stopped = false }: { error?: string; stopped?: boolean } = {}): void => {
      if (finished) return;
      finished = true;

      // 中断・エラー・正常完了のいずれでも、保留中の末尾をマスクして流す。
      const flushed = deltaMasker.flush();
      if (flushed) {
        currentAssistantText += flushed;
        this.emit(record, "text", { delta: flushed });
      }

      // プロバイダは通常 text delta をストリームする。このフォールバックは
      // message_end で初めて最終テキストを含めるプロバイダも支援する。
      const finalAssistant = lastAssistantMessage(session);
      const finalText = this.masker.mask(contentText(finalAssistant?.content));
      if (finalText && !currentAssistantText) {
        currentAssistantText = finalText;
        this.emit(record, "text", { delta: finalText });
      } else if (finalText && currentAssistantText && finalText.startsWith(currentAssistantText)) {
        const remainder = finalText.slice(currentAssistantText.length);
        if (remainder) this.emit(record, "text", { delta: remainder });
      }

      run.status = stopped ? "stopped" : error ? "error" : "completed";
      run.endedAt = Date.now();
      if (error) run.error = this.masker.mask(error);
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
            if (event.message?.role === "assistant") {
              currentAssistantText = "";
              deltaMasker = createStreamingSecretMasker(this.masker);
            }
            break;
          case "message_update":
            if (event.assistantMessageEvent?.type === "text_delta") {
              const emitted = deltaMasker.push(event.assistantMessageEvent.delta ?? "");
              if (emitted) {
                currentAssistantText += emitted;
                this.emit(record, "text", { delta: emitted });
              }
            }
            break;
          case "message_end":
            // アシスタントメッセージの確定時に保留していた末尾を流す。
            if (event.message?.role === "assistant") {
              const flushed = deltaMasker.flush();
              if (flushed) {
                currentAssistantText += flushed;
                this.emit(record, "text", { delta: flushed });
              }
            }
            break;
          case "tool_execution_start": {
            const tool: ToolCall = {
              id: event.toolCallId ?? "",
              name: event.toolName ?? "",
              args: this.masker.mask(toolArgsSummary(event.args)),
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
            const output = this.masker.mask(toolResultSummary(event.result));
            const tool = record.tools.get(event.toolCallId ?? "");
            if (tool) {
              tool.done = true;
              tool.isError = Boolean(event.isError);
              tool.output = output;
            }
            this.emit(record, "tool_end", {
              id: event.toolCallId ?? "",
              name: event.toolName ?? "",
              isError: Boolean(event.isError),
              output,
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
              text: this.masker.mask(
                typeof event.error === "string" ? event.error : String(event.error ?? ""),
              ),
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
