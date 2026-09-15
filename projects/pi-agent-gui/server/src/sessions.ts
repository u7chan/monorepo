/**
 * インメモリのセッションストア。ラン (prompt() 1 回) は HTTP リクエストから切り離して
 * バックグラウンドで走り、イベントは単調増加の seq 付きでログされるため購読者は途中参加・再接続できる。
 *
 * セッション状態の所有者はこのクラス 1 つに保つ (create と project 削除・settings 変更中の送信抑止・
 * queue / run / subscriber は複数箇所へ分けると競合を追えなくなる)。pi イベント変換と DTO 組み立ては
 * run-events / session-projection / compaction-view / session-payload の純関数・アダプタへ出す。
 */
import { randomUUID } from "node:crypto";
import type { PiBff } from "./agent";
import type { AgentCatalog } from "./agents";
import { compactionsOf } from "./compaction-view";
import { contextUsageOf, type PiRuntimeLike, type PiSessionLike } from "./pi-runtime";
import type { ProjectStore } from "./projects";
import { createSecretMasker, type SecretMasker } from "./redact";
import { createRunEventBridge, userFacingError, type RunSettlement } from "./run-events";
import type {
  CreateSessionOptions,
  PostMessageResultInternal,
  RunState,
  SessionRecord,
  SessionSubscriber,
  UpdateSessionSettingsInput,
} from "./session-record";
import { projectSessionPayload, projectSessionSummary } from "./session-payload";
import { truncate } from "./session-projection";
import type {
  AgentPayloadInfo,
  AgentSkillInfo,
  CompactionInfo,
  EventEntry,
  Project,
  RunStatus,
  SessionPayload,
  SessionSummary,
  SkillDef,
  SSEEventData,
  SSEEventType,
} from "./schema";

const MAX_EVENT_LOG = 2000;
const MAX_QUEUE_DEPTH = 10;
const QUEUE_DELAY_MS = 200;
const SESSION_TTL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const TITLE_MAX = 60;

export interface HttpLikeError extends Error {
  statusCode?: number;
}

function httpError(statusCode: number, message: string): HttpLikeError {
  const error = new Error(message) as HttpLikeError;
  error.statusCode = statusCode;
  return error;
}

export class SessionStore {
  pi: PiRuntimeLike | null;
  catalog: AgentCatalog;
  /** SSE / ログへ出すテキストから既知の秘密値を除く (保護対象が無ければ素通し) */
  masker: SecretMasker;
  /** セッションの cwd 解決元。未指定なら projectId を受け付けない (未所属のみ) */
  projects: ProjectStore | null;
  records: Map<string, SessionRecord>;
  sweeper: ReturnType<typeof setInterval>;

  constructor({
    pi,
    catalog,
    masker,
    projects,
  }: {
    pi?: PiRuntimeLike | null;
    catalog?: AgentCatalog;
    masker?: SecretMasker | null;
    projects?: ProjectStore | null;
  } = {}) {
    if (!catalog) throw new Error("SessionStore requires an agent catalog");
    this.pi = pi || null;
    this.catalog = catalog;
    this.masker = masker ?? createSecretMasker([]);
    this.projects = projects ?? null;
    this.records = new Map();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  get size(): number {
    return this.records.size;
  }

  async create({ agentId, model, thinkingLevel, projectId }: CreateSessionOptions = {}): Promise<SessionRecord> {
    if (!this.pi) {
      const error = new Error("ランタイムを利用できません") as HttpLikeError;
      error.statusCode = 503;
      throw error;
    }
    const project = this.resolveProject(projectId);
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
    // 表示用のエージェント情報は作成時にスナップショット化する (以降の定義編集・インポートを遡及させない)
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
    // どちらも未指定ならランタイム側のアプリ既定に委ねる。cwd は所属プロジェクトの相対パスで渡す。
    const { session } = await this.pi.createSession({
      agent: { ...agent, skillIds: [...agent.skillIds] },
      skills,
      model: model ?? agent.model,
      thinkingLevel: thinkingLevel ?? agent.thinkingLevel,
      cwd: project?.cwd ?? "",
    });
    // 上記の await 中に DELETE /api/projects/:id が走ると、このセッションは破棄対象の
    // スナップショットに含まれない。登録の直前に存在を再確認し、消えていれば作った SDK セッションを
    // dispose して 400 にする (削除済みプロジェクトを参照する孤児を records に残さない)。
    // この確認と records.set() の間に await を挟むと再び競合するため、必ず同期で登録する。
    if (projectId !== undefined && !this.projects?.get(projectId)) {
      (session as PiSessionLike).dispose?.();
      throw httpError(400, `Project not found: ${projectId}`);
    }
    const record: SessionRecord = {
      id: randomUUID(),
      session: session as PiSessionLike,
      agentId: agent.id,
      ...(projectId ? { projectId } : {}),
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
      messageMetrics: new WeakMap(),
      compactionMeta: new Map(),
      changingSettings: false,
    };
    this.records.set(record.id, record);
    return record;
  }

  /**
   * チャット単位のモデル・Effort 変更。同じ SDK セッション・履歴・タイトルを保つ。
   * 実行中・キューあり・SDK 非 idle・別の設定変更中は 409。
   */
  async updateSettings(record: SessionRecord, input: UpdateSessionSettingsInput): Promise<SessionPayload> {
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

    // available へ厳密照合し、暗黙のフォールバックはしない
    const modelObject = input.model ? this.pi.resolveModel?.(input.model) : undefined;
    if (input.model && !modelObject) {
      throw httpError(400, `Model is not available: ${input.model.provider}/${input.model.id}`);
    }
    const { session } = record;
    // フラグは変更開始前に同期的に予約する (await 後だと送信が割り込む)。
    record.changingSettings = true;
    try {
      if (input.model) {
        // モデルだけの変更では現在の実効 Effort を退避し、切替後に再適用する。SDK が非対応値を補正する。
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
    // 実効値 (SDK 補正後) を正として、購読中の全クライアントへ同期する
    return this.emitResync(record);
  }

  /** resync は payload と同じ lastSeq を持つ (クライアントのカーソルになる) */
  emitResync(record: SessionRecord): SessionPayload {
    const payload = this.payload(record);
    payload.lastSeq = record.seq + 1;
    this.emit(record, "resync", payload);
    return payload;
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  /**
   * プロジェクト単位の破棄。destroy() が abort → dispose → 購読者への session_deleted まで行うため、
   * 停止機構は足さず対象を絞るだけにする。
   */
  async destroyByProject(projectId: string): Promise<void> {
    const targets = [...this.records.values()].filter((record) => record.projectId === projectId);
    for (const record of targets) await this.destroy(record);
  }

  list(): SessionSummary[] {
    return [...this.records.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).map((record) => this.summary(record));
  }

  statusOf(record: SessionRecord): RunStatus {
    if (record.run?.status === "running" || record.session.isStreaming) return "running";
    if (record.queue.length > 0) return "queued";
    return record.run?.status || "idle";
  }

  isBusy(record: SessionRecord): boolean {
    return this.statusOf(record) === "running" || this.statusOf(record) === "queued";
  }

  /** 実行中ならキューに入れ、それ以外は即座にランを始める。 */
  postMessage(record: SessionRecord, text: string): PostMessageResultInternal {
    // 設定変更中の送信は 409 (BFF のルートでも同じ扱い)
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

  /** 実行中のランを中断し、キューに積まれたメッセージも捨てる。 */
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
   * `after` より後のバッファ済みエントリをリプレイする。クライアントが
   * バッファより大きく遅れている場合はセッション全文を持つ resync を 1 件送る。
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
    return projectSessionPayload({
      record,
      status: this.statusOf(record),
      cwd: this.cwdOf(record),
      masker: this.masker,
    });
  }

  compactionsOf(record: SessionRecord): CompactionInfo[] {
    return compactionsOf(record, this.masker);
  }

  summary(record: SessionRecord): SessionSummary {
    return projectSessionSummary({ record, status: this.statusOf(record), masker: this.masker });
  }

  /**
   * SessionPayload.cwd は rootCwd 相対 (未所属は "")。プロジェクトは所属を変えられないため、
   * SDK セッションに固定された作成時の cwd と同じ値を返す。
   */
  cwdOf(record: SessionRecord): string {
    if (!record.projectId) return "";
    return this.projects?.get(record.projectId)?.cwd ?? "";
  }

  /** 未知の projectId は未所属へ落とさず 400 にする (登録漏れ・誤参照を黙って通さない)。 */
  resolveProject(projectId?: string): Project | undefined {
    if (projectId === undefined) return undefined;
    const project = this.projects?.get(projectId);
    if (!project) throw httpError(400, `Project not found: ${projectId}`);
    return project;
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
        // すでに切断済みの購読者
      }
      try {
        subscriber.close?.();
      } catch {
        // 同上
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

  /** バックグラウンドランを開始する (呼び出し側はセッションが idle であることを保証する)。 */
  startRun(record: SessionRecord, text: string): RunState {
    const { session } = record;
    const run: RunState = {
      id: randomUUID(),
      // ログ・SSE 用に保持するプロンプトはマスクする (モデルへ渡す text はユーザー入力そのまま)。
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

    const finish = ({ error, stopped = false }: RunSettlement = {}): void => {
      if (finished) return;
      finished = true;

      // 保留中の差分・最終テキスト・送信メッセージ待ちの resync は run_end より先に配る
      bridge.finalize();

      run.status = stopped ? "stopped" : error ? "error" : "completed";
      run.endedAt = Date.now();
      if (error) run.error = this.masker.mask(error);
      this.emit(record, "run_end", {
        runId: run.id,
        status: run.status,
        error: run.error,
        messageCount: session.messages.length,
        queueDepth: record.queue.length,
        // SDK は message_end をリスナーへ配ってから履歴へ入れるため、usage イベントの context は
        // 直前の応答までの値になる (compaction 直後は不明値のまま)。ここでは履歴反映済みの値を配る。
        context: contextUsageOf(session),
      });

      if (record.queue.length > 0) {
        setTimeout(() => this.pump(record), QUEUE_DELAY_MS).unref?.();
      }
    };

    const bridge = createRunEventBridge({
      session,
      masker: this.masker,
      tools: record.tools,
      messageMetrics: record.messageMetrics,
      compactionMeta: record.compactionMeta,
      emit: (type, data) => this.emit(record, type, data),
      emitResync: () => this.emitResync(record),
      onSettled: (outcome) => finish(outcome),
    });

    const unsubscribe = session.subscribe(bridge.listener);
    session
      .prompt(text)
      .then(() => {
        // agent_settled は prompt() の解決より先に届くはずで、これはその保険。
        if (!finished) finish();
        unsubscribe();
      })
      .catch((error) => {
        if (!finished) finish({ error: userFacingError(error) });
        unsubscribe();
      });

    return run;
  }

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

export { computeMessageMetrics } from "./run-events";
export type {
  PiCompactionResult,
  PiRuntimeLike,
  PiSessionEntryLike,
  PiSessionEvent,
  PiSessionEventListener,
  PiSessionLike,
} from "./pi-runtime";
export type {
  CompactionMeta,
  CreateSessionOptions,
  PostMessageResultInternal,
  RunState,
  SessionRecord,
  SessionSubscriber,
  UpdateSessionSettingsInput,
} from "./session-record";

/** 互換用の再エクスポート (pi ランタイムの実装として使える) */
export type PiRuntime = PiBff;
