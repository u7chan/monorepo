/**
 * セッションのライフサイクル。ラン (prompt() 1 回) は HTTP リクエストから切り離して
 * バックグラウンドで走り、イベントは単調増加の seq 付きでログされるため購読者は途中参加・再接続できる。
 *
 * 会話の永続化は session-store に委譲する。ここでは「このプロセスで live な record」と
 * 「ストア上の descriptor (meta)」をまとめて扱い、id ごとの load / evict / delete を直列化する。
 * pi イベント変換と DTO 組み立ては run-events / session-projection / compaction-view / session-payload の
 * 純関数・アダプタへ出す。
 */
import { randomBytes } from "node:crypto";
import { SANDBOX_NOT_CONFIGURED_MESSAGE, type PiBff } from "./agent";
import { composePromptSnapshot } from "./agent";
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
import { displayableMessages, truncate } from "./session-projection";
import type { SandboxWorkspaceClient } from "./sandbox/client";
import {
  SessionDamagedError,
  SessionFileWriter,
  generateSessionId,
  listSessionIds,
  prepareSessionStore,
  readSessionFile,
  readSessionMeta,
  removeSessionDir,
  sessionHeaderOf,
  sessionJsonlPath,
  sessionWorkdirAbs,
  sessionWorkdirRel,
  writeSessionMeta,
  type PromptSnapshot,
  type SessionEntryLike,
  type SessionMeta,
} from "./session-store";
import type {
  AgentPayloadInfo,
  AgentSkillInfo,
  CompactionInfo,
  EventEntry,
  ModelRef,
  Project,
  RunStatus,
  SessionPayload,
  SessionSummary,
  SkillDef,
  SSEEventData,
  SSEEventType,
  ThinkingLevel,
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

export interface SessionStoreOptions {
  pi?: PiRuntimeLike | null;
  catalog?: AgentCatalog;
  masker?: SecretMasker | null;
  projects?: ProjectStore | null;
  /** 会話ストアの絶対パス。未指定は永続化なし (テスト・未設定のデプロイ) */
  storeDir?: string | null;
  /** ストアの設定エラー (ワークスペース内の指定など)。あるとセッション作成を 503 で拒む */
  storeError?: string;
  /** 作業フォルダを mkdir するサンドボックスクライアント (永続化ありのとき必須) */
  workspace?: SandboxWorkspaceClient | null;
  /** BFF 側のワークスペース root (作業フォルダの絶対パス解決用) */
  rootCwd?: string;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelLabel(model?: { provider: string; id: string } | null): string | undefined {
  if (!model) return undefined;
  return `${model.provider}/${model.id}`;
}

function parseModelLabel(value: string | undefined): ModelRef | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** SSE のカーソル。`<generation>:<seq>` を基本とし、旧クライアントの数値のみも受ける */
export function parseEventCursor(raw: string | undefined): { generation?: string; seq: number } | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const colon = raw.indexOf(":");
  const generation = colon === -1 ? undefined : raw.slice(0, colon);
  const seqText = colon === -1 ? raw : raw.slice(colon + 1);
  const seq = Number.parseInt(seqText, 10);
  if (!Number.isFinite(seq) || seq < 0) return undefined;
  return generation ? { generation, seq } : { seq };
}

function entriesOf(session: PiSessionLike): SessionEntryLike[] {
  const manager = session.sessionManager as { getEntries?(): unknown[]; getBranch?(): unknown[] } | undefined;
  const entries = manager?.getEntries?.() ?? manager?.getBranch?.() ?? [];
  return Array.isArray(entries) ? (entries as SessionEntryLike[]) : [];
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
  /** 会話ストアの絶対パス。null は永続化なし */
  storeDir: string | null;
  /** 作業フォルダの作成に使う。BFF は作業領域のファイルを直接触らない */
  workspace: SandboxWorkspaceClient | null;
  rootCwd: string;
  /** ストア上のメタデータ。live な record の分も持つ */
  descriptors: Map<string, SessionMeta>;
  /** id ごとのライフサイクル (load / evict)。完了まで同じ id の再ロードを待たせる */
  lifecycle: Map<string, Promise<unknown>>;
  /** 削除予約中の id */
  deleting: Set<string>;
  /** close 中は新規の利用を受け付けない */
  closing: boolean;
  /** ストアの設定エラー。永続化を有効にできない状態をセッション作成で 503 にする */
  storeError: string | undefined;
  /** sweep の二重実行を防ぐ */
  sweeping: boolean;

  constructor({ pi, catalog, masker, projects, storeDir, storeError, workspace, rootCwd }: SessionStoreOptions = {}) {
    if (!catalog) throw new Error("SessionStore requires an agent catalog");
    this.pi = pi || null;
    this.catalog = catalog;
    this.masker = masker ?? createSecretMasker([]);
    this.projects = projects ?? null;
    this.storeDir = storeDir ?? null;
    this.storeError = storeError;
    this.workspace = workspace ?? null;
    this.rootCwd = rootCwd ?? process.cwd();
    this.records = new Map();
    this.descriptors = new Map();
    this.lifecycle = new Map();
    this.deleting = new Set();
    this.closing = false;
    this.sweeping = false;
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  get size(): number {
    return this.records.size;
  }

  /** store を走査して復元可能なセッションの descriptor を作る (SDK セッションは開かない) */
  async init(): Promise<void> {
    if (!this.storeDir) return;
    await prepareSessionStore(this.storeDir);
    for (const id of await listSessionIds(this.storeDir)) {
      const meta = await readSessionMeta(this.storeDir, id);
      if (meta) {
        this.descriptors.set(id, meta);
      } else {
        console.warn(`[pi-agent-gui] セッションの meta.json を読めません: ${id}`);
      }
    }
  }

  async create({ agentId, model, thinkingLevel, projectId }: CreateSessionOptions = {}): Promise<SessionRecord> {
    if (this.closing) throw httpError(503, "サーバーを終了しています");
    if (this.storeError) throw httpError(503, `会話ストアを利用できません: ${this.storeError}`);
    if (!this.pi) {
      throw httpError(503, "ランタイムを利用できません");
    }
    const project = this.resolveProject(projectId);
    const selectedAgentId = agentId || this.catalog.listAgents()[0]?.id;
    const agent = selectedAgentId ? this.catalog.getAgent(selectedAgentId) : undefined;
    if (!agent) {
      throw httpError(400, "Agent not found");
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
    const id = this.storeDir ? generateSessionId(this.storeDir) : randomBytes(5).toString("hex");
    const workdir = this.storeDir ? sessionWorkdirRel(id) : (project?.cwd ?? "");
    if (this.storeDir) await this.ensureWorkdir(workdir);
    const promptSnapshot = composePromptSnapshot(agent, skills);
    const created = await this.pi.createSession({
      agent: { ...agent, skillIds: [...agent.skillIds] },
      skills,
      model: model ?? agent.model,
      thinkingLevel: thinkingLevel ?? agent.thinkingLevel,
      cwd: workdir,
      ...(this.storeDir ? { sessionId: id } : {}),
      promptSnapshot,
    });
    // 上記の await 中に DELETE /api/projects/:id が走ると、このセッションは破棄対象の
    // スナップショットに含まれない。登録の直前に存在を再確認し、消えていれば作った SDK セッションを
    // dispose して 400 にする (削除済みプロジェクトを参照する孤児を records に残さない)。
    if (projectId !== undefined && !this.projects?.get(projectId)) {
      (created.session as PiSessionLike).dispose?.();
      throw httpError(400, `Project not found: ${projectId}`);
    }
    const record = this.buildRecord({
      id,
      session: created.session as PiSessionLike,
      agentId: agent.id,
      agent: agentInfo,
      promptSnapshot: created.promptSnapshot ?? promptSnapshot,
      workdir,
      project,
      title: "",
      createdAt: Date.now(),
    });
    this.records.set(record.id, record);
    if (this.storeDir) {
      record.writer = new SessionFileWriter(this.storeDir, id);
      await this.persist(record);
    }
    return record;
  }

  private buildRecord({
    id,
    session,
    agentId,
    agent,
    promptSnapshot,
    workdir,
    project,
    title,
    createdAt,
  }: {
    id: string;
    session: PiSessionLike;
    agentId: string;
    agent: AgentPayloadInfo;
    promptSnapshot: PromptSnapshot;
    workdir: string;
    project: Project | undefined;
    title: string;
    createdAt: number;
  }): SessionRecord {
    const meta: SessionMeta = {
      version: 1,
      id,
      title,
      createdAt,
      lastUsedAt: Date.now(),
      messageCount: 0,
      agentId,
      agent,
      promptSnapshot,
      ...(project ? { projectCwd: project.cwd, projectName: project.name } : {}),
      ...(modelLabel(session.model) ? { model: modelLabel(session.model) } : {}),
      ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
    };
    return {
      id,
      session,
      agentId,
      ...(project ? { projectId: project.id, projectCwd: project.cwd, projectName: project.name } : {}),
      workdir,
      storeDir: this.storeDir ?? "",
      promptSnapshot,
      meta,
      generation: randomBytes(4).toString("hex"),
      persistTail: Promise.resolve(),
      agent,
      title,
      createdAt,
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
  }

  private async ensureWorkdir(workdirRel: string): Promise<void> {
    if (!this.storeDir) return;
    if (!this.workspace) throw httpError(503, SANDBOX_NOT_CONFIGURED_MESSAGE);
    await this.workspace.createDir(workdirRel);
  }

  /** 未ロードならストアから復元する。deleting / closing / eviction 中の id は復元の完了を待つ */
  async resolve(id: string): Promise<SessionRecord | undefined> {
    for (;;) {
      if (this.deleting.has(id) || this.closing) return undefined;
      const pending = this.lifecycle.get(id);
      if (pending) {
        // eviction / 先行ロードの完了を待ち、状態を取り直してから判断する
        await pending.catch(() => {});
        continue;
      }
      const live = this.records.get(id);
      if (live) return live;
      const meta = this.descriptors.get(id);
      if (!meta || !this.storeDir || !this.pi) return undefined;
      const promise = this.load(meta);
      this.lifecycle.set(id, promise);
      try {
        return await promise;
      } finally {
        if (this.lifecycle.get(id) === promise) this.lifecycle.delete(id);
      }
    }
  }

  private async load(meta: SessionMeta): Promise<SessionRecord> {
    const id = meta.id;
    if (this.deleting.has(id)) throw httpError(404, "Session not found");
    const { parsed } = await readSessionFile(this.storeDir as string, id);
    if (parsed.kind === "damaged") {
      throw httpError(
        409,
        `${new SessionDamagedError(parsed.reason).message} (${sessionJsonlPath(id, this.storeDir as string)})`,
      );
    }
    const entries = parsed.kind === "ok" ? parsed.entries : [];
    const workdir = sessionWorkdirRel(id);
    await this.ensureWorkdir(workdir);
    const restored = this.restoreInputs(meta, entries);
    const created = await (this.pi as PiRuntimeLike).createSession({
      sessionId: id,
      entries,
      promptSnapshot: meta.promptSnapshot,
      model: restored.model,
      thinkingLevel: restored.thinkingLevel,
      cwd: workdir,
    });
    const session = created.session as PiSessionLike;
    if (this.deleting.has(id)) {
      session.dispose?.();
      throw httpError(404, "Session not found");
    }
    const modelRecorded = this.recordEffectiveModel(session, restored.recordedModel);
    const record = this.buildRecord({
      id,
      session,
      agentId: meta.agentId,
      agent: meta.agent,
      promptSnapshot: meta.promptSnapshot,
      workdir,
      project: undefined,
      title: meta.title,
      createdAt: meta.createdAt,
    });
    record.lastUsedAt = meta.lastUsedAt;
    record.meta = meta;
    // 所属は保存値から復元し、projectId だけを読み取り時に解決する
    record.projectCwd = meta.projectCwd;
    record.projectName = meta.projectName;
    record.projectId = this.projectIdOfCwd(meta.projectCwd);
    if (this.storeDir) {
      record.writer = new SessionFileWriter(this.storeDir, id, {
        completeBytes: parsed.kind === "ok" ? parsed.completeBytes : 0,
        entries,
        needsSeparator: parsed.kind === "ok" ? parsed.needsSeparator : false,
      });
    }
    this.records.set(id, record);
    // 実効モデルのフォールバックは model_change の追記ごと保存する。件数の補正だけなら履歴は同じ
    // なので、writer を通さず meta だけを書き戻す (履歴が同じでも writer は全量を書き直す)
    const backfillCount = meta.messageCount !== displayableMessages(session, this.masker).length;
    if (modelRecorded) await this.persist(record);
    else if (backfillCount) await this.persist(record, { jsonl: false });
    return record;
  }

  /** JSONL の最後の model_change → meta.model → アプリ既定 の順に、whitelist 内の候補を決める */
  private restoreInputs(
    meta: SessionMeta,
    entries: SessionEntryLike[],
  ): { model?: ModelRef; recordedModel?: ModelRef; thinkingLevel?: ThinkingLevel } {
    const lastModel = [...entries].reverse().find((entry) => entry.type === "model_change");
    const recordedModel =
      lastModel && typeof lastModel.provider === "string" && typeof lastModel.modelId === "string"
        ? { provider: lastModel.provider, id: lastModel.modelId }
        : undefined;
    const candidate = [recordedModel, parseModelLabel(meta.model)].find(
      (reference) => reference && this.pi?.resolveModel?.(reference),
    );
    const lastThinking = [...entries].reverse().find((entry) => entry.type === "thinking_level_change");
    const thinkingLevel =
      lastThinking && typeof lastThinking.thinkingLevel === "string"
        ? (lastThinking.thinkingLevel as ThinkingLevel)
        : (meta.thinkingLevel as ThinkingLevel | undefined);
    return {
      ...(candidate ? { model: candidate } : {}),
      ...(recordedModel ? { recordedModel } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }

  /**
   * 復元で実効モデルが保存値と変わったとき (whitelist 外 → アプリ既定) は、model_change entry を
   * 追記して次回復元で元モデルへ戻らないようにする。SDK の setModel は thinking を触るため使わない。
   */
  private recordEffectiveModel(session: PiSessionLike, recorded: ModelRef | undefined): boolean {
    const effective = session.model;
    if (!effective) return false;
    if (recorded && recorded.provider === effective.provider && recorded.id === effective.id) return false;
    const manager = session.sessionManager as
      | { appendModelChange?: (provider: string, id: string) => void }
      | undefined;
    if (!manager?.appendModelChange) return false;
    manager.appendModelChange(effective.provider, effective.id);
    return true;
  }

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
      throw httpError(503, "ランタイムを利用できません");
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
    await this.persist(record);
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

  list(): SessionSummary[] {
    const live = [...this.records.values()].map((record) => this.summary(record));
    const liveIds = new Set(this.records.keys());
    const persisted = [...this.descriptors.values()]
      .filter((meta) => !liveIds.has(meta.id))
      .map((meta) => this.summaryOfMeta(meta));
    return [...live, ...persisted].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
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
        throw httpError(429, `Message queue is full (max ${MAX_QUEUE_DEPTH})`);
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
   * `after` より後のバッファ済みエントリをリプレイする。復元で seq が 0 に戻っているため、
   * 世代 (`<generation>:<seq>`) が一致しない場合はリプレイせず resync を送る。
   */
  /** live な record の同期取得 (未ロードは resolve を使う) */
  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  subscribe(
    record: SessionRecord,
    after: string | number | undefined,
    send: (entry: EventEntry) => void,
    close?: () => void,
  ): () => void {
    const subscriber: SessionSubscriber = { send, close };
    record.subscribers.add(subscriber);
    const cursor = parseEventCursor(after === undefined ? undefined : String(after));
    const earliest = record.events.length > 0 ? record.events[0].seq : record.seq + 1;
    // 世代が一致しないカーソルは差分に使わない (seq は復元で 0 に戻るため数値だけでは同定できない)
    const usable = cursor?.generation === record.generation;
    if (!cursor || !usable || cursor.seq > record.seq || cursor.seq + 1 < earliest) {
      send({ seq: record.seq, type: "resync", data: this.payload(record), at: Date.now() });
    } else {
      for (const entry of record.events) {
        if (entry.seq > cursor.seq) send(entry);
      }
    }
    return () => record.subscribers.delete(subscriber);
  }

  payload(record: SessionRecord): SessionPayload {
    return projectSessionPayload({
      record,
      status: this.statusOf(record),
      cwd: this.cwdOf(record),
      projectId: this.projectIdOf(record),
      masker: this.masker,
    });
  }

  compactionsOf(record: SessionRecord): CompactionInfo[] {
    return compactionsOf(record, this.masker);
  }

  summary(record: SessionRecord): SessionSummary {
    return projectSessionSummary({
      record,
      status: this.statusOf(record),
      projectId: this.projectIdOf(record),
      masker: this.masker,
    });
  }

  private summaryOfMeta(meta: SessionMeta): SessionSummary {
    return {
      sessionId: meta.id,
      title: meta.title || "無題のセッション",
      agentId: meta.agentId,
      agentName: meta.agent.name,
      status: "idle",
      queueDepth: 0,
      messageCount: meta.messageCount,
      createdAt: meta.createdAt,
      lastUsedAt: meta.lastUsedAt,
      ...(meta.model ? { model: meta.model } : {}),
      ...(this.projectIdOfCwd(meta.projectCwd) ? { projectId: this.projectIdOfCwd(meta.projectCwd) } : {}),
    };
  }

  /** SessionPayload.cwd は rootCwd 相対。永続化ありでは作業フォルダ、なしでは従来どおりプロジェクト cwd */
  cwdOf(record: SessionRecord): string {
    return record.workdir;
  }

  private projectIdOf(record: SessionRecord): string | undefined {
    return this.projectIdOfCwd(record.projectCwd);
  }

  private projectIdOfCwd(projectCwd: string | undefined): string | undefined {
    if (!projectCwd) return undefined;
    return this.projects?.findByCwd(projectCwd)?.id;
  }

  /** 未知の projectId は未所属へ落とさず 400 にする (登録漏れ・誤参照を黙って通さない)。 */
  resolveProject(projectId?: string): Project | undefined {
    if (projectId === undefined) return undefined;
    const project = this.projects?.get(projectId);
    if (!project) throw httpError(400, `Project not found: ${projectId}`);
    return project;
  }

  /** プロジェクト解除: 配下の live セッションを停止し、所属が外れた payload を購読者へ配る */
  async releaseProject(projectCwd: string): Promise<void> {
    for (const record of Array.from(this.records.values())) {
      if (record.projectCwd !== projectCwd) continue;
      // 待機メッセージは解除後に実行しない (stop で queue を破棄してから abort する)
      if (record.queue.length > 0 || this.isBusy(record) || record.session.isStreaming) {
        await this.stop(record);
      }
      // projectCwd は残す。所属は読み取り時に解決するため、同じ cwd の再登録で戻る
      record.projectId = undefined;
      this.emitResync(record);
    }
  }

  /** 旧 API 互換: live な session を削除する (deleteSession と同じ) */
  async destroy(record: SessionRecord): Promise<void> {
    await this.deleteSession(record.id);
  }

  /** セッションを削除する。SDK を開かずに消せる (モデル未認証・JSONL 破損でも可)。作業フォルダは残す */
  async deleteSession(id: string): Promise<boolean> {
    if (!this.records.has(id) && !this.descriptors.has(id)) return false;
    this.deleting.add(id);
    try {
      const pending = this.lifecycle.get(id);
      if (pending) await pending.catch(() => {});
      const record = this.records.get(id);
      if (record) {
        record.queue = [];
        if (this.isBusy(record) || record.session.isStreaming) await record.session.abort().catch(() => {});
        await this.flush(record);
        record.session.dispose?.();
        this.records.delete(id);
        this.notifyDeleted(record);
      }
      if (this.storeDir) await removeSessionDir(this.storeDir, id);
      this.descriptors.delete(id);
      return true;
    } finally {
      this.deleting.delete(id);
    }
  }

  private notifyDeleted(record: SessionRecord): void {
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

  /**
   * meta と JSONL の書込みを直列化する。失敗は record.persistError に残す (in-memory の実行は止めない)。
   * `jsonl: false` は履歴が変わっていない呼び出し用 (meta だけを書く)。
   */
  persist(record: SessionRecord, { jsonl = true }: { jsonl?: boolean } = {}): Promise<void> {
    if (!record.writer || !this.storeDir) return Promise.resolve();
    const storeDir = this.storeDir;
    const run = async (): Promise<void> => {
      // 削除済み・別世代に差し替わった record は書かない (store を復活させない)
      if (this.deleting.has(record.id) || this.records.get(record.id) !== record) return;
      const session = record.session;
      const meta: SessionMeta = {
        ...record.meta,
        id: record.id,
        title: record.title,
        lastUsedAt: record.lastUsedAt,
        messageCount: displayableMessages(session, this.masker).length,
        agentId: record.agentId,
        agent: record.agent,
        promptSnapshot: record.promptSnapshot,
        ...(record.projectCwd ? { projectCwd: record.projectCwd } : {}),
        ...(record.projectName ? { projectName: record.projectName } : {}),
        ...(modelLabel(session.model) ? { model: modelLabel(session.model) } : {}),
        ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
      };
      if (!meta.projectCwd) {
        delete meta.projectCwd;
        delete meta.projectName;
      }
      record.meta = meta;
      this.descriptors.set(record.id, meta);
      // 今回の保存だけを評価する (過去の失敗は成功で消す)
      let failure: string | undefined;
      try {
        await writeSessionMeta(storeDir, meta);
        if (jsonl) {
          await record.writer?.schedule(
            sessionHeaderOf(meta, sessionWorkdirAbs(this.rootCwd, record.id)),
            entriesOf(session),
          );
        }
      } catch (error) {
        failure = messageFor(error);
      }
      failure = failure ?? record.writer?.error;
      record.persistError = failure;
      if (failure && record.persistErrorLogged !== failure) {
        record.persistErrorLogged = failure;
        console.warn(`[pi-agent-gui] セッションの保存に失敗しました (${record.id}): ${failure}`);
      }
      if (!failure) record.persistErrorLogged = undefined;
    };
    const next = record.persistTail.then(run, run);
    record.persistTail = next.catch(() => {});
    return record.persistTail;
  }

  async flush(record: SessionRecord): Promise<void> {
    await record.persistTail.catch(() => {});
    await record.writer?.flush();
  }

  async sweep(): Promise<void> {
    if (this.sweeping || this.closing) return;
    this.sweeping = true;
    try {
      const cutoff = Date.now() - SESSION_TTL_MS;
      // 破棄中に records を変更するため、走査対象は先に固める
      for (const [id, record] of Array.from(this.records)) {
        if (this.isBusy(record) || record.subscribers.size > 0 || record.changingSettings) continue;
        if (this.deleting.has(id) || this.lifecycle.has(id)) continue;
        if (record.lastUsedAt >= cutoff) continue;
        const promise = (async () => {
          // 最終保存を試み、成功したときだけメモリから外す (失敗は次の sweep で再試行する)
          await this.persist(record);
          await this.flush(record);
          if (record.persistError || record.writer?.error) return;
          record.session.dispose?.();
          this.records.delete(id);
        })();
        this.lifecycle.set(id, promise);
        try {
          await promise;
        } finally {
          if (this.lifecycle.get(id) === promise) this.lifecycle.delete(id);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** health 用のストア状態。dirty は保存に失敗している live セッション数 */
  status(): { path: string | null; ok: boolean; error?: string; dirty: number } {
    const dirty = Array.from(this.records.values()).filter(
      (record) => record.persistError || record.writer?.error,
    ).length;
    return {
      path: this.storeDir,
      ok: !this.storeError && !this.closing,
      ...(this.storeError ? { error: this.storeError } : {}),
      dirty,
    };
  }

  /** store の準備失敗を共有する (bootstrap の init 失敗・設定エラー) */
  markStoreUnavailable(error: string): void {
    this.storeError = error;
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.sweeper);
    await Promise.allSettled(Array.from(this.lifecycle.values()));
    for (const record of Array.from(this.records.values())) {
      if (this.isBusy(record)) await record.session.abort().catch(() => {});
      await this.flush(record);
      record.session.dispose?.();
    }
    this.records.clear();
  }

  /** バックグラウンドランを開始する (呼び出し側はセッションが idle であることを保証する)。 */
  startRun(record: SessionRecord, text: string): RunState {
    const { session } = record;
    const run: RunState = {
      id: randomBytes(8).toString("hex"),
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
        // 一覧 API / meta と同じ表示メッセージ数。ここを履歴の生件数 (session.messages.length) へ
        // 戻すと同名フィールドの定義が 2 つに戻る
        messageCount: displayableMessages(session, this.masker).length,
        queueDepth: record.queue.length,
        // SDK は message_end をリスナーへ配ってから履歴へ入れるため、usage イベントの context は
        // 直前の応答までの値になる (compaction 直後は不明値のまま)。ここでは履歴反映済みの値を配る。
        context: contextUsageOf(session),
      });
      // 最後の assistant entry を取りこぼさないよう、ラン終了時に必ず保存する
      void this.persist(record);

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
      // SDK は listener 通知の後に entry を append する。1 拍置いてから読む (保存点の順序テストあり)
      onPersist: () => queueMicrotask(() => void this.persist(record)),
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
    if (this.deleting.has(record.id) || this.records.get(record.id) !== record) return;
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
    // 送信中に購読を解除した相手には送らない (Set の反復は削除に強い)
    for (const subscriber of record.subscribers) {
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
  SessionDescriptor,
  SessionRecord,
  SessionSubscriber,
  UpdateSessionSettingsInput,
} from "./session-record";

/** 互換用の再エクスポート (pi ランタイムの実装として使える) */
export type PiRuntime = PiBff;
