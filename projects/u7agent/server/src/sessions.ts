/**
 * ask_user の待機を 1 回だけ settle する。abort listener を必ず外し、回答済みの tombstone を
 * 同じ run の後からの abort で消さない (2 回目の回答が 404 に化けるのを防ぐ)。
 */
function settleQuestion(pending: PendingQuestion, finish: () => void): void {
  if (pending.settled) return;
  pending.settled = true;
  pending.detach?.();
  finish();
}

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
import { spaceIdOf } from "./spaces";
import { workspaceAbs } from "./app-paths";
import { SANDBOX_NOT_CONFIGURED_MESSAGE, type PiBff } from "./agent";
import { composePromptSnapshot } from "./agent";
import type { AgentCatalog } from "./agents";
import { validateAskUserAnswers, type AskUserHost } from "./ask-user-tool";
import { stripAttachedFiles } from "./attachments";
import { compactionsOf, recordCompactionOutcome } from "./compaction-view";
import { projectHistoryPage } from "./history-projection";
import type { NotificationService } from "./notifications";
import { contextUsageOf, type PiRuntimeLike, type PiSessionEvent, type PiSessionLike } from "./pi-runtime";
import type { ProjectStore } from "./projects";
import { createSecretMasker, type SecretMasker } from "./redact";
import { classifyRunError, composeRunError, retryWaitingText } from "./error-classify";
import { createRunEventBridge, type RunSettlement } from "./run-events";
import type {
  CreateSessionOptions,
  PendingQuestion,
  PostMessageResultInternal,
  RunState,
  SessionRecord,
  SessionSubscriber,
  UpdateSessionSettingsInput,
} from "./session-record";
import { projectSessionPayload, projectSessionSummary } from "./session-payload";
import { displayableMessages, truncate } from "./session-projection";
import type { SandboxWorkspaceClient } from "./sandbox/client";
import { SandboxRequestError } from "./sandbox/client";
import {
  SessionDamagedError,
  SessionFileWriter,
  emptySessionSends,
  generateSessionId,
  listSessionIds,
  prepareSessionStore,
  readSessionFile,
  readSessionMeta,
  entryRunIdsFromJsonl,
  readSessionSends,
  removeSessionDir,
  sessionHeaderOf,
  sessionJsonlPath,
  sessionWorkdirRel,
  writeSessionMeta,
  RUN_ID_FIELD,
  writeSessionSends,
  type PromptSnapshot,
  type SessionEntryLike,
  type SessionMeta,
  type SessionSends,
} from "./session-store";
import type {
  AgentDef,
  AgentPayloadInfo,
  AgentSkillInfo,
  AskUserAnswer,
  AskUserQuestion,
  CompactionInfo,
  EventEntry,
  ModelRef,
  Project,
  RunStatus,
  SessionCompactionResult,
  SessionNotifyResponse,
  SessionPinnedResponse,
  SessionPayload,
  SessionSummary,
  SessionTitleResponse,
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

/** SDK の compact() が投げる既知の理由。完全一致で分類する (部分一致は別の失敗を拾い得る) */
const COMPACTION_TOO_SMALL = "Nothing to compact (session too small)";
const COMPACTION_ALREADY = "Already compacted";
const COMPACTION_CANCELLED = "Compaction cancelled";

export interface HttpLikeError extends Error {
  statusCode?: number;
}

function httpError(statusCode: number, message: string): HttpLikeError {
  const error = new Error(message) as HttpLikeError;
  error.statusCode = statusCode;
  return error;
}

/** compaction の失敗理由。応答の status と、終端 status イベントの文言を組で持つ */
interface CompactionFailure {
  error: HttpLikeError;
  text: string;
}

/**
 * SDK 例外を HTTP status と応答文言へ分類する。未知の例外は詳細を出さず 500 に畳む
 * (例外の文字列には API キーなどの秘密が混じり得るため、既知の 3 つ以外はそのまま配らない)。
 */
function compactionFailure(error: unknown): CompactionFailure {
  const message = messageFor(error);
  if (message === COMPACTION_TOO_SMALL) {
    const text = "まだ要約できる古い会話がありません";
    return { error: httpError(400, text), text };
  }
  if (message === COMPACTION_ALREADY) {
    const text = "会話はすでに圧縮されています";
    return { error: httpError(409, text), text };
  }
  // aborted された SDK は "Compaction cancelled" を投げる。ユーザーの stop と extension の
  // cancel を区別できないため、どちらも中止として同じ文言にする
  if (message === COMPACTION_CANCELLED) {
    const text = "圧縮を中止しました";
    return { error: httpError(409, text), text };
  }
  return { error: httpError(500, "会話の圧縮に失敗しました"), text: "会話の圧縮に失敗しました" };
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
  /** 完了通知の送信先。未指定なら通知しない (テスト・未設定のデプロイ) */
  notifications?: NotificationService | null;
  /**
   * 送信対応記録の書込み。既定は `writeSessionSends` で、書込み失敗の再試行をテストするためだけに
   * 差し替えられる (SessionFileWriter の writeChunk と同じテスト用の差し込み口)
   */
  writeSends?: (storeDir: string, id: string, sends: SessionSends) => void;
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

/**
 * Agent の割り当てスキルと索引 (表示用情報 + プロンプトスナップショット)。セッション作成と
 * セッション未確定のプレビュー (GET /api/skills/session) で同じ索引を組むため共有する。未知の id は 400。
 */
export function resolveAgentSkills(
  catalog: AgentCatalog,
  agentId?: string,
): {
  agent: AgentDef;
  skills: SkillDef[];
  agentInfo: AgentPayloadInfo;
  promptSnapshot: PromptSnapshot;
} {
  const selectedAgentId = agentId || catalog.builtinAgent().id;
  const agent = selectedAgentId ? catalog.getAgent(selectedAgentId) : undefined;
  if (!agent) throw httpError(400, "Agent not found");
  const skills = agent.skillIds
    .map((skillId) => catalog.getSkill(skillId))
    .filter((skill): skill is SkillDef => Boolean(skill));
  return {
    agent,
    skills,
    agentInfo: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      skillIds: [...agent.skillIds],
      skills: skills.map((skill): AgentSkillInfo => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
      })),
    },
    promptSnapshot: composePromptSnapshot(agent, skills),
  };
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
  /** 同一会話のピン更新。save / restore / delete と競合しないよう直列化する */
  pinUpdates: Map<string, Promise<void>>;
  /** 削除予約中の id */
  deleting: Set<string>;
  /** close 中は新規の利用を受け付けない */
  closing: boolean;
  /** ストアの設定エラー。永続化を有効にできない状態をセッション作成で 503 にする */
  storeError: string | undefined;
  /** sweep の二重実行を防ぐ */
  sweeping: boolean;
  /** 完了通知。null は通知なし */
  notifications: NotificationService | null;
  /** 送信対応記録の書込み (テスト差し替え用) */
  writeSendsFile: (storeDir: string, id: string, sends: SessionSends) => void;

  constructor({
    pi,
    catalog,
    masker,
    projects,
    storeDir,
    storeError,
    workspace,
    rootCwd,
    notifications,
    writeSends,
  }: SessionStoreOptions = {}) {
    if (!catalog) throw new Error("SessionStore requires an agent catalog");
    this.pi = pi || null;
    this.catalog = catalog;
    this.masker = masker ?? createSecretMasker([]);
    this.projects = projects ?? null;
    this.storeDir = storeDir ?? null;
    this.storeError = storeError;
    this.workspace = workspace ?? null;
    this.rootCwd = rootCwd ?? process.cwd();
    this.notifications = notifications ?? null;
    this.writeSendsFile = writeSends ?? writeSessionSends;
    this.records = new Map();
    this.descriptors = new Map();
    this.lifecycle = new Map();
    this.pinUpdates = new Map();
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
        console.warn(`[u7agent] セッションの meta.json を読めません: ${id}`);
      }
    }
  }

  async create({
    spaceId: requestedSpaceId,
    agentId,
    model,
    thinkingLevel,
    projectId,
    notify,
  }: CreateSessionOptions = {}): Promise<SessionRecord> {
    const spaceId = spaceIdOf(requestedSpaceId);
    if (spaceId !== "default" && projectId !== undefined)
      throw httpError(400, "追加スペースではプロジェクトを利用できません");
    if (this.closing) throw httpError(503, "サーバーを終了しています");
    if (this.storeError) throw httpError(503, `会話ストアを利用できません: ${this.storeError}`);
    if (!this.pi) {
      throw httpError(503, "ランタイムを利用できません");
    }
    const project = this.resolveProject(projectId);
    // 表示用のエージェント情報は作成時にスナップショット化する (以降の定義編集を遡及させない)
    const { agent, skills, agentInfo, promptSnapshot } = resolveAgentSkills(this.catalog, agentId);
    const id = this.storeDir ? generateSessionId(this.storeDir) : randomBytes(5).toString("hex");
    // 所属セッションの cwd は登録ディレクトリそのもの。プロジェクトのディレクトリは作らず存在だけ確かめる。
    // スクラッチを作るのは未所属だけ (永続化なしでは作業フォルダのライフサイクルを持たない)
    const workdir = this.workdirOf(id, project?.cwd, spaceId);
    if (this.storeDir || spaceId !== "default") {
      if (project) await this.requireProjectDir(project.cwd);
      else await this.ensureWorkdir(workdir);
    }
    const created = await this.pi.createSession({
      agent: { ...agent, skillIds: [...agent.skillIds] },
      skills,
      // カタログスキルの索引は name / description を使うので、説明の出所も渡す (復元と同じ形にする)
      agentSkills: agentInfo.skills,
      model: model ?? agent.model,
      thinkingLevel: thinkingLevel ?? agent.thinkingLevel,
      cwd: workdir,
      ...(this.storeDir ? { sessionId: id } : {}),
      // 所有権の束縛は永続化の有無に依らない (serve ツールは常に会話 id を持つ)
      ownerSessionId: id,
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
      spaceId,
      id,
      session: created.session as PiSessionLike,
      agentId: agent.id,
      agent: agentInfo,
      promptSnapshot: created.promptSnapshot ?? promptSnapshot,
      workdir,
      project,
      title: "",
      createdAt: Date.now(),
      notify: notify === true,
    });
    this.records.set(record.id, record);
    if (this.storeDir) {
      record.writer = new SessionFileWriter(this.storeDir, id);
      await this.persist(record);
    }
    return record;
  }

  private buildRecord({
    spaceId = "default",
    id,
    session,
    agentId,
    agent,
    promptSnapshot,
    workdir,
    project,
    title,
    createdAt,
    notify,
    pinned = false,
  }: {
    spaceId?: string;
    id: string;
    session: PiSessionLike;
    agentId: string;
    agent: AgentPayloadInfo;
    promptSnapshot: PromptSnapshot;
    workdir: string;
    project: Project | undefined;
    title: string;
    createdAt: number;
    notify: boolean;
    pinned?: boolean;
  }): SessionRecord {
    const meta: SessionMeta = {
      spaceId,
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
      ...(notify ? { notify: true } : {}),
      ...(pinned ? { pinned: true } : {}),
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
      toolTimings: new Map(),
      questions: new Map(),
      messageMetrics: new WeakMap(),
      userMessageRuns: new WeakMap(),
      entryRunIds: new Map(),
      unsentSends: [],
      sendsDirty: false,
      compactionMeta: new Map(),
      changingSettings: false,
      compacting: false,
      notify,
      pinned,
    };
  }

  private async ensureWorkdir(workdirRel: string): Promise<void> {
    if (!workdirRel) return;
    if (!this.workspace) throw httpError(503, SANDBOX_NOT_CONFIGURED_MESSAGE);
    await this.workspace.createDir(workdirRel);
  }

  /**
   * セッションの作業ディレクトリ (root 相対)。所属があれば登録ディレクトリ、無ければ永続化ありのときだけ
   * セッション専用のスクラッチ。永続化なしの未所属は root ("") のまま (既存のテスト・未設定デプロイ)。
   */
  private workdirOf(id: string, projectCwd?: string, spaceId = "default"): string {
    if (projectCwd) return projectCwd;
    return this.storeDir || spaceId !== "default" ? sessionWorkdirRel(id, spaceId) : "";
  }

  /**
   * 登録ディレクトリの存在確認。セッション作成では mkdir しない (誤った cwd を黙って作らない)。
   * サンドボックスの 404 は「登録したディレクトリが消えた」なので 400 に寄せる。永続化なしは作業フォルダを
   * 持たないため確認せず、プレビュー (GET /api/skills/session) も作成と同じ条件でここを呼ぶ。
   */
  async requireProjectDir(cwd: string): Promise<void> {
    if (!this.storeDir) return;
    if (!this.workspace) throw httpError(503, SANDBOX_NOT_CONFIGURED_MESSAGE);
    try {
      await this.workspace.listFiles(cwd);
    } catch (error) {
      if (error instanceof SandboxRequestError) {
        throw httpError(error.status === 404 ? 400 : error.status, error.message);
      }
      throw httpError(502, messageFor(error));
    }
  }

  /** 未ロードならストアから復元する。deleting / closing / eviction 中の id は復元の完了を待つ */
  async resolve(id: string): Promise<SessionRecord | undefined> {
    for (;;) {
      if (this.deleting.has(id) || this.closing) return undefined;
      const pending = this.lifecycle.get(id) ?? this.pinUpdates.get(id);
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
    // cwd は保存値の projectCwd をそのまま使う (登録解除・消失していても復元先を変えない)。
    // 未所属 (projectCwd なし) のときだけスクラッチを保証する
    const workdir = this.workdirOf(id, meta.projectCwd, meta.spaceId);
    if (!meta.projectCwd) await this.ensureWorkdir(workdir);
    const restored = this.restoreInputs(meta, entries);
    const created = await (this.pi as PiRuntimeLike).createSession({
      sessionId: id,
      ownerSessionId: id,
      entries,
      promptSnapshot: meta.promptSnapshot,
      // 復元では定義を引き直さず、セッションのスナップショットだけで索引を組む (遡及させない)
      agentSkills: meta.agent.skills,
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
      spaceId: meta.spaceId ?? "default",
      id,
      session,
      agentId: meta.agentId,
      agent: meta.agent,
      promptSnapshot: meta.promptSnapshot,
      workdir,
      project: undefined,
      title: meta.title,
      createdAt: meta.createdAt,
      notify: meta.notify === true,
      pinned: meta.pinned === true,
    });
    record.lastUsedAt = meta.lastUsedAt;
    record.meta = meta;
    // 所属は保存値から復元し、projectId だけを読み取り時に解決する
    record.projectCwd = meta.projectCwd;
    record.projectName = meta.projectName;
    record.projectId = this.projectIdOfCwd(meta.projectCwd);
    // run 対応は JSONL の entry へ写した注記を正とする (entry の存在が証跡なので、本文や時刻での
    // 推測をしない)。未送信の記録は、その注記に載っている run だけを保存済みとして外す
    const sends = this.storeDir ? readSessionSends(this.storeDir, id) : emptySessionSends();
    record.entryRunIds = entryRunIdsFromJsonl(entries);
    const persistedRuns = new Set(record.entryRunIds.values());
    record.unsentSends = sends.unsent.filter((item) => !persistedRuns.has(item.runId));
    record.sendsDirty = record.unsentSends.length !== sends.unsent.length;
    if (this.storeDir) {
      record.writer = new SessionFileWriter(this.storeDir, id, {
        completeBytes: parsed.kind === "ok" ? parsed.completeBytes : 0,
        entries,
        needsSeparator: parsed.kind === "ok" ? parsed.needsSeparator : false,
      });
    }
    this.records.set(id, record);
    // 突き合わせの結果を書き直す (書けなければ dirty のまま残り、次の persist / flush で再試行する)
    if (record.sendsDirty) this.writeSends(record);
    // 実効モデルのフォールバックは model_change の追記ごと保存する。件数の補正だけなら履歴は同じ
    // なので、writer を通さず meta だけを書き戻す (履歴が同じでも writer は全量を書き直す)
    const backfillCount = meta.messageCount !== displayableMessages(session, this.masker).length;
    if (modelRecorded) await this.persist(record);
    else if (backfillCount) await this.persist(record, { jsonl: false });
    return record;
  }

  /** JSONL の最後の model_change → meta.model → アプリ既定 の順に、利用可能なモデル内の候補を決める */
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
   * 復元で実効モデルが保存値と変わったとき (許可リスト外 → アプリ既定) は、model_change entry を
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

  /**
   * 通知トグル。model / thinkingLevel の設定変更と違い、SDK の設定変更も busy 判定も通さない
   * (実行中でも切り替えられ、送るかどうかは finish 時点の値で決まる)。
   * 未ロードのセッションは meta.json だけを書き換え、SDK セッションを開かない
   * (モデルランタイムが使えない間でも通知を切り替えられるように)。
   * 応答は live / 未ロード共通の `{ sessionId, notify }` だけにする (会話全文は返さない)。
   */
  async setNotify(id: string, notify: boolean): Promise<SessionNotifyResponse | undefined> {
    // 復元中の id は完了を待つ (descriptor を先に書き換えると load の meta で上書きされる)
    const pending = this.lifecycle.get(id);
    if (pending) await pending.catch(() => {});
    const live = this.records.get(id);
    if (live) {
      live.notify = notify;
      // 履歴は変わらないので meta.json だけを書く
      await this.persist(live, { jsonl: false });
      // 保存失敗を成功扱いにしない (in-memory の実行は止めないが、この応答は 500)
      if (live.persistError) throw httpError(500, `セッションの保存に失敗しました: ${live.persistError}`);
      return { sessionId: live.id, notify: live.notify };
    }
    const meta = this.descriptors.get(id);
    if (!meta || !this.storeDir) return undefined;
    const updated: SessionMeta = { ...meta };
    if (notify) updated.notify = true;
    else delete updated.notify;
    const storeDir = this.storeDir;
    // 書き込みも lifecycle へ載せる。載せないと、書き込み中の同じ id の GET が古い descriptor で
    // load(meta) を始め、復元した record と一覧を古い値へ戻してしまう (ディスクと応答は新しい値のまま)。
    const write = (async () => {
      await writeSessionMeta(storeDir, updated);
      this.descriptors.set(id, updated);
    })();
    this.lifecycle.set(id, write);
    try {
      await write;
    } catch (error) {
      throw httpError(500, `セッションの保存に失敗しました: ${messageFor(error)}`);
    } finally {
      if (this.lifecycle.get(id) === write) this.lifecycle.delete(id);
    }
    return { sessionId: id, notify };
  }

  /** ピン留めは SDK の設定・履歴・最終使用時刻に触れず、live / 未ロードとも meta だけを更新する。 */
  async setPinned(id: string, pinned: boolean): Promise<SessionPinnedResponse | undefined> {
    const previous = this.pinUpdates.get(id) ?? Promise.resolve();
    const update = previous.then(
      () => this.setPinnedState(id, pinned),
      () => this.setPinnedState(id, pinned),
    );
    const settled = update.then(
      () => {},
      () => {},
    );
    this.pinUpdates.set(id, settled);
    try {
      return await update;
    } finally {
      if (this.pinUpdates.get(id) === settled) this.pinUpdates.delete(id);
    }
  }

  private async setPinnedState(id: string, pinned: boolean): Promise<SessionPinnedResponse | undefined> {
    if (this.deleting.has(id) || this.closing) return undefined;
    // 復元中の id は完了を待ち、古い descriptor から作った record で更新を上書きしない。
    const pending = this.lifecycle.get(id);
    if (pending) await pending.catch(() => {});
    if (this.deleting.has(id) || this.closing) return undefined;
    const live = this.records.get(id);
    if (live) {
      const previous = live.pinned;
      live.pinned = pinned;
      const failure = await this.persist(live, { jsonl: false });
      if (failure) {
        live.pinned = previous;
        if (previous) live.meta.pinned = true;
        else delete live.meta.pinned;
        this.descriptors.set(id, live.meta);
        // 後続の通常保存が失敗した変更を引き継がないよう、旧値も直列化して確定する。
        await this.persist(live, { jsonl: false });
        throw httpError(500, `セッションの保存に失敗しました: ${failure}`);
      }
      return { sessionId: live.id, pinned: live.pinned };
    }
    const meta = this.descriptors.get(id);
    if (!meta || !this.storeDir) return undefined;
    const updated: SessionMeta = { ...meta };
    if (pinned) updated.pinned = true;
    else delete updated.pinned;
    const storeDir = this.storeDir;
    // 未ロードの書込みも lifecycle に載せ、並行する GET が古い descriptor を復元しないようにする。
    const write = (async () => {
      await writeSessionMeta(storeDir, updated);
      this.descriptors.set(id, updated);
    })();
    this.lifecycle.set(id, write);
    try {
      await write;
    } catch (error) {
      throw httpError(500, `セッションの保存に失敗しました: ${messageFor(error)}`);
    } finally {
      if (this.lifecycle.get(id) === write) this.lifecycle.delete(id);
    }
    return { sessionId: id, pinned };
  }

  /**
   * 会話タイトルの変更。notify と同じく SDK に触らず busy 判定も通さないため、実行中でも変えられる。
   * 未ロードのセッションは meta.json だけを書き換え、SDK セッションを開かない。応答は
   * `{ sessionId, title }` だけを返し、一覧と同じ正規化 (trim / マスク / 上限) 後の値を載せる。
   */
  async setTitle(id: string, title: string): Promise<SessionTitleResponse | undefined> {
    // 自動タイトルと同じ正規化を 1 行に収める (改行を持つ名前が一覧の行を崩さないように)
    const next = truncate(this.masker.mask(title).replace(/\s+/g, " ").trim(), TITLE_MAX);
    if (!next) throw httpError(400, "title is required");
    // 復元中の id は完了を待つ (descriptor を先に書き換えると load の meta で上書きされる)
    const pending = this.lifecycle.get(id);
    if (pending) await pending.catch(() => {});
    const live = this.records.get(id);
    if (live) {
      live.title = next;
      await this.persist(live, { jsonl: false });
      if (live.persistError) throw httpError(500, `セッションの保存に失敗しました: ${live.persistError}`);
      return { sessionId: live.id, title: live.title };
    }
    const meta = this.descriptors.get(id);
    if (!meta || !this.storeDir) return undefined;
    const updated: SessionMeta = { ...meta, title: next };
    const storeDir = this.storeDir;
    // 書き込み中の GET が古い descriptor で load(meta) を始めないよう、notify と同じく lifecycle へ載せる
    const write = (async () => {
      await writeSessionMeta(storeDir, updated);
      this.descriptors.set(id, updated);
    })();
    this.lifecycle.set(id, write);
    try {
      await write;
    } catch (error) {
      throw httpError(500, `セッションの保存に失敗しました: ${messageFor(error)}`);
    } finally {
      if (this.lifecycle.get(id) === write) this.lifecycle.delete(id);
    }
    return { sessionId: id, title: next };
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

  list(spaceId?: string): SessionSummary[] {
    const live = [...this.records.values()].map((record) => this.summary(record));
    const liveIds = new Set(this.records.keys());
    const persisted = [...this.descriptors.values()]
      .filter((meta) => !liveIds.has(meta.id))
      .map((meta) => this.summaryOfMeta(meta));
    return [...live, ...persisted]
      .filter((item) => spaceId === undefined || item.spaceId === spaceId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  statusOf(record: SessionRecord): RunStatus {
    // 圧縮中の排他は保存待ちも覆うため、キュー待ちより先に見る
    if (record.compacting) return "compacting";
    if (record.run?.status === "running" || record.session.isStreaming) return "running";
    if (record.queue.length > 0) return "queued";
    return record.run?.status || "idle";
  }

  isBusy(record: SessionRecord): boolean {
    const status = this.statusOf(record);
    return status === "running" || status === "queued" || status === "compacting";
  }

  /**
   * 実行中ならキューに入れ、それ以外は即座にランを始める。`titleSource` は一覧のタイトルの元本文で、
   * 省略時は text。`/skill:` の展開結果は長いため、展開前のユーザー入力からタイトルを作るために使う。
   * `runId` は未送信メッセージの再送で、受理済みの run id を引き継ぐために使う (未指定は新規採番)。
   */
  postMessage(
    record: SessionRecord,
    text: string,
    options: { titleSource?: string; runId?: string } = {},
  ): PostMessageResultInternal {
    // 設定変更中の送信は 409 (BFF のルートでも同じ扱い)
    if (record.changingSettings) {
      throw httpError(409, "Session settings are being changed");
    }
    // 圧縮中も送信はキューへ積む (排他の正は BFF の flag。SDK は保存待ちの間 idle に見える)
    const running = record.run?.status === "running" || record.session.isStreaming;
    if (running || record.compacting) {
      if (record.queue.length >= MAX_QUEUE_DEPTH) {
        throw httpError(429, `Message queue is full (max ${MAX_QUEUE_DEPTH})`);
      }
    }
    if (!record.title) {
      // title はユーザーが打った本文から作る (添付の注記と /skill: の展開結果を混ぜない)
      record.title = truncate(
        this.masker
          .mask(stripAttachedFiles(options.titleSource ?? text))
          .replace(/\s+/g, " ")
          .trim(),
        TITLE_MAX,
      );
    }
    record.lastUsedAt = Date.now();
    // run id はキュー受付 / 即時開始のどちらでも先に振る。エントリ保存前に落ちた送信を「未送信」として
    // 残す記録にも同じ id を使うため、startRun に渡す前にここで確定させる
    const runId = options.runId ?? randomBytes(8).toString("hex");
    this.rememberUnsent(record, runId, text);

    if (running || record.compacting) {
      // 圧縮中も送信はキューへ積む。run id はここで振り、キューから始まる run の id として
      // 応答へ返す (クライアントが自分の送信と run_start / 履歴 entry を対応付けるため)
      record.queue.push({ text, runId });
      this.emit(record, "queued", {
        position: record.queue.length,
        queueDepth: record.queue.length,
        prompt: this.masker.mask(text),
      });
      return { queued: true, queueDepth: record.queue.length, runId };
    }

    const run = this.startRun(record, text, runId);
    return { queued: false, queueDepth: 0, runId: run.id };
  }

  /**
   * 未送信メッセージの再送。保存済みの生の本文を使い、同じ run id で実行し直す (受理の記録は
   * そのまま。user entry が保存された時点で `syncSendMap` が消す)。二重の再送は実行 / キュー中の
   * run id を見て弾く。見つからない run id は undefined (既に保存済みか破棄済み)。
   */
  resend(record: SessionRecord, runId: string): PostMessageResultInternal | undefined {
    const send = record.unsentSends.find((item) => item.runId === runId);
    if (!send) return undefined;
    if (this.isRunActive(record, runId)) {
      // 二重の再送は重ねない。状態は既に配られているので resync も足さない
      const queued = record.queue.some((item) => item.runId === runId);
      return { queued, queueDepth: record.queue.length, runId };
    }
    const result = this.postMessage(record, send.text, { runId });
    // 別タブの未送信表示を更新する。run_start は run id を配るが、キュー受付の `queued` は配らない
    this.emitResync(record);
    return result;
  }

  /**
   * 未送信メッセージの破棄。"missing" は記録が無い (再送済み / 別タブで破棄済み)、"running" は
   * 再送が実行中またはキュー待ちで消せないことを表す。破棄は購読者へ resync で配る (別タブの
   * 未送信バブルを消すため)。
   */
  discardUnsent(record: SessionRecord, runId: string): "ok" | "missing" | "running" {
    const index = record.unsentSends.findIndex((item) => item.runId === runId);
    if (index === -1) return "missing";
    if (this.isRunActive(record, runId)) return "running";
    record.unsentSends.splice(index, 1);
    record.sendsDirty = true;
    this.writeSends(record);
    this.emitResync(record);
    return "ok";
  }

  /** その run id がまだ実行中 / キュー待ちか。終了した run は未送信の再送 / 破棄を妨げない */
  private isRunActive(record: SessionRecord, runId: string): boolean {
    if (record.queue.some((item) => item.runId === runId)) return true;
    return record.run?.id === runId && (record.run.status === "running" || record.session.isStreaming);
  }

  /** 受理した送信を「未送信」として控える (同じ run id の再送では重ねない) */
  private rememberUnsent(record: SessionRecord, runId: string, text: string): void {
    // 永続化なしは再起動を跨がないため記録を持たない (未開始のキュー破棄は queue_cleared の
    // runIds がクライアントへ直接伝える)
    if (!record.writer || !this.storeDir) return;
    if (record.unsentSends.some((item) => item.runId === runId)) return;
    record.unsentSends.push({ runId, text, at: Date.now() });
    record.sendsDirty = true;
    this.writeSends(record);
  }

  /**
   * JSONL に載った user entry と run の対応を控え、保存済みになった分を「未送信」から外す。
   * `persist` が JSONL の書込みを確定させてから呼ぶ (書けていない entry を保存済みにしない)。
   */
  /**
   * 渡された entry スナップショットのうち、JSONL へ書けた user entry の run 対応を控え、保存済みに
   * なった分を「未送信」から外す。`persist` が writer へ渡したのと同じ配列を渡す (await 中に SDK が
   * 追記した entry を保存済みにしないため)。
   */
  private syncSendMap(record: SessionRecord, entries: SessionEntryLike[]): void {
    if (!record.writer || !this.storeDir) return;
    let changed = false;
    for (const entry of entries) {
      if (entry.type !== "message" || typeof entry.id !== "string" || entry.id === "") continue;
      const message = entry.message as { role?: unknown } | undefined;
      if (!message || message.role !== "user") continue;
      const runId = record.userMessageRuns.get(message);
      if (runId === undefined || record.entryRunIds.get(entry.id) === runId) continue;
      record.entryRunIds.set(entry.id, runId);
      const index = record.unsentSends.findIndex((item) => item.runId === runId);
      if (index !== -1) record.unsentSends.splice(index, 1);
      changed = true;
    }
    if (changed) {
      record.sendsDirty = true;
      this.writeSends(record);
    }
  }

  /**
   * 送信対応記録の保存。失敗しても会話の実行 / 保存は止めず、dirty を残して次の persist / flush で
   * やり直す (メモリだけ進めてディスクが古いままだと、再起動後に保存済みの送信を未送信として
   * 再実行できてしまう)。
   */
  private writeSends(record: SessionRecord): boolean {
    if (!record.writer || !this.storeDir) return true;
    if (!record.sendsDirty) return true;
    try {
      this.writeSendsFile(this.storeDir, record.id, { unsent: record.unsentSends });
      record.sendsDirty = false;
      record.sendsError = undefined;
      return true;
    } catch (error) {
      record.sendsError = messageFor(error);
      console.warn(`[u7agent] 未送信記録の保存に失敗しました (${record.id}): ${record.sendsError}`);
      return false;
    }
  }

  /**
   * user message entry へ送信の run id を写す。entry と run の対応を JSONL 自身に持たせ、
   * 別ファイル (sends.json) の書込みだけ失敗しても再起動後に対応を失わない。SDK は未知の
   * フィールドをそのまま保持するため、SDK 形式は壊れない。
   */
  private annotateRunIds(record: SessionRecord, entries: SessionEntryLike[]): SessionEntryLike[] {
    return entries.map((entry) => {
      if (entry.type !== "message" || typeof entry.id !== "string" || entry.id === "") return entry;
      const message = entry.message as { role?: unknown } | undefined;
      if (!message || message.role !== "user") return entry;
      const runId = record.userMessageRuns.get(message) ?? record.entryRunIds.get(entry.id);
      if (runId === undefined || entry[RUN_ID_FIELD] === runId) return entry;
      return { ...entry, [RUN_ID_FIELD]: runId };
    });
  }

  /** 実行中のランを中断し、キューに積まれたメッセージも捨てる。 */
  async stop(record: SessionRecord): Promise<{ ok: true; status: RunStatus }> {
    record.lastUsedAt = Date.now();
    if (record.queue.length > 0) {
      // 破棄した送信は「未送信」として見せる (実行されないまま黙って消さない)
      const clearedRunIds = record.queue.map((item) => item.runId);
      record.queue = [];
      this.emit(record, "queue_cleared", { runIds: clearedRunIds });
    }
    // 先に task を持ち、abort の後にその settle を待つ (abort は SDK の待機で、保存待ちは覆わない)。
    // SDK の abort() は abortCompaction() も呼ぶため、圧縮中もこれ 1 つで巻き戻せる
    const compaction = record.compactionTask;
    if (record.run?.status === "running" || record.session.isStreaming || record.compacting) {
      // 待機中は aborted の assistant が投影に残らず stopReason では判定できないため、要求を控えておく
      if (record.run?.status === "running") record.run.stopRequested = true;
      // 回答待ちは abort シグナルでも取り消されるが、signal が届かない実装でも止まるように先に reject する
      this.cancelQuestions(record);
      await record.session.abort().catch(() => {});
    }
    // entry を append 済み (保存待ち) の段階では圧縮を巻き戻せない。成功と保存結果を正とする
    await compaction?.catch(() => {});
    return { ok: true, status: this.statusOf(record) };
  }

  /**
   * ask_user ツールの実体。待機の所有は record (SessionStore) 側に置き、ツールは回答を await する。
   * 定義側が束縛した会話 id で record を引き、見つからなければツールをエラー結果へ落とす。
   */
  askUserHost(): AskUserHost {
    return {
      ask: (sessionId, toolCallId, questions, signal) => {
        const record = this.records.get(sessionId);
        if (!record) return Promise.reject(new Error(`Session not found: ${sessionId}`));
        return this.askQuestion(record, toolCallId, questions, signal);
      },
    };
  }

  /**
   * 回答待ちを登録する。回答・abort シグナル・取り消しのどれか 1 つで settle し、二重 settle では
   * 何もしない (settle 済みの promise へ後から reject を送らない)。abort は signal を正とする。
   */
  askQuestion(
    record: SessionRecord,
    toolCallId: string,
    questions: AskUserQuestion[],
    signal: AbortSignal | undefined,
  ): Promise<AskUserAnswer[]> {
    return new Promise<AskUserAnswer[]>((resolve, reject) => {
      const pending: PendingQuestion = {
        questions: [...questions],
        resolve,
        reject,
        settled: false,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      // abort された質問は tombstone を残さない (回答済みではなく、回答不可能になったため)
      const onAbort = (): void => {
        record.questions.delete(toolCallId);
        settleQuestion(pending, () => reject(new Error("ask_user was aborted")));
      };
      record.questions.set(toolCallId, pending);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * 回答を 1 回だけ受け付ける。settle 済みの entry は tombstone として残すため、2 回目は「回答済み」、
   * 未知の id は「不明」を返す (2 タブで同時に回答しても片方だけが成立する)。
   */
  answerQuestion(
    record: SessionRecord,
    toolCallId: string,
    answers: AskUserAnswer[],
  ): { status: "ok" } | { status: "missing" } | { status: "answered" } | { status: "invalid"; error: string } {
    record.lastUsedAt = Date.now();
    const pending = record.questions.get(toolCallId);
    if (!pending) return { status: "missing" };
    if (pending.settled) return { status: "answered" };
    const error = validateAskUserAnswers(pending.questions, answers);
    if (error) return { status: "invalid", error };
    // 質問順に揃える (details / モデル向け text の並びを送信順に依存させない)
    const ordered = [...answers].sort((a, b) => a.index - b.index);
    settleQuestion(pending, () => pending.resolve(ordered));
    return { status: "ok" };
  }

  /**
   * 未 settle の待機を取り消す (stop / finish / delete / close)。settle 済みの tombstone は残し、
   * 同じ toolCallId への 2 回目の回答を 409 のままにする。
   */
  private cancelQuestions(record: SessionRecord): void {
    for (const [toolCallId, pending] of record.questions) {
      if (pending.settled) continue;
      record.questions.delete(toolCallId);
      settleQuestion(pending, () => pending.reject(new Error("ask_user was cancelled")));
    }
  }

  /**
   * 手動 compaction。SDK の compact() の完了を待ち、成功時は entry の保存まで排他を保持する。
   * 開始 / 終端の配信順序と失敗の分類は docs/compaction.md / docs/api-sessions.md を正とする。
   */
  async compact(record: SessionRecord): Promise<SessionCompactionResult> {
    if (this.closing) throw httpError(503, "サーバーを終了しています");
    const { session } = record;
    const runCompact = session.compact?.bind(session);
    if (!runCompact) throw httpError(501, "このランタイムは手動圧縮に対応していません");
    // 実効 busy は BFF の flag で見る。SDK の isIdle はキュー / 設定変更を知らないため併せて見る
    if (this.isBusy(record) || session.isStreaming || session.isIdle === false || record.changingSettings) {
      throw httpError(409, "セッションが実行中のため圧縮できません");
    }
    // 排他は最初の await より前に立て、task も同期で登録する (二重 POST / stop / delete の取りこぼしを防ぐ)
    record.compacting = true;
    record.compactionStartedAt = Date.now();
    // 開始は resync だけ。client は payload の status / compactionStartedAt から表示を導出する。
    // SDK は待ちが無ければ compaction_end を同期で emit するため、listener の購読より先に配る
    this.emitResync(record);
    const task = this.runCompaction(record, runCompact);
    record.compactionTask = task;
    const failure = await task;
    if (failure) throw failure.error;
    return { sessionId: record.id, status: this.statusOf(record) };
  }

  /**
   * compaction の本体。成功時は保存完了まで排他を保持し、終端は resync → status の順に配る。
   * 失敗・中止は `compaction` を配らず、finally で解放してから同じ順で終端を配る。
   */
  private async runCompaction(
    record: SessionRecord,
    runCompact: () => Promise<unknown>,
  ): Promise<CompactionFailure | undefined> {
    const { session } = record;
    let unsubscribe: () => void = () => {};
    let sdkFailure: CompactionFailure | undefined;
    let saveFailure: CompactionFailure | undefined;
    let savedCount = 0;
    try {
      unsubscribe = session.subscribe((event: PiSessionEvent) => {
        if (event.type !== "compaction_end") return;
        // 履歴が変わったときだけ 1 件配る。resync は保存後の終端処理が担う
        const compactions = recordCompactionOutcome({
          session,
          compactionMeta: record.compactionMeta,
          masker: this.masker,
          event,
        });
        if (!compactions) return;
        this.emit(record, "compaction", {
          compaction: compactions[compactions.length - 1],
          count: compactions.length,
        });
      });
      await runCompact();
      // SDK は entry を SessionManager へ積んでから解決する。排他を保持したまま保存する
      await this.persist(record);
      // pump や他の保存で値が変わる前 (await persist の直後) に控える
      const saveError = record.persistError;
      if (saveError !== undefined) {
        const reason = this.masker.mask(saveError);
        saveFailure = {
          error: httpError(500, `セッションの保存に失敗しました: ${reason}`),
          text: `会話を圧縮しましたが、保存に失敗しました: ${reason}`,
        };
      } else {
        savedCount = this.compactionsOf(record).length;
      }
    } catch (error) {
      sdkFailure = compactionFailure(error);
      if (sdkFailure.error.statusCode === 500) {
        console.warn(`[u7agent] 会話の圧縮に失敗しました (${record.id}): ${messageFor(error)}`);
      }
    } finally {
      unsubscribe();
      record.compacting = false;
      record.compactionStartedAt = undefined;
      record.compactionTask = undefined;
    }
    const failure = sdkFailure ?? saveFailure;
    if (this.canPublishCompaction(record)) {
      // 終端は resync → status の順 (client は resync を状態の正、status を文言として扱う)
      this.emitResync(record);
      this.emit(record, "status", {
        state: "compacting",
        text: failure ? failure.text : `会話を圧縮しました（${savedCount}回目）`,
      });
      // 終端処理の後に 1 回だけ pump する (圧縮中は pump が止まっている)
      if (record.queue.length > 0) this.pump(record);
    }
    return failure;
  }

  /** 削除中 / close 中は終端の配信と pump を抑止する (保存と flush は呼び出し側が待つ) */
  private canPublishCompaction(record: SessionRecord): boolean {
    return !this.closing && !this.deleting.has(record.id) && this.records.get(record.id) === record;
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
      try {
        send({ seq: record.seq, type: "resync", data: this.payload(record), at: Date.now() });
      } catch (error) {
        // payload の失敗で購読者だけが残ると sweep 対象外になるため、登録を戻してから投げる
        record.subscribers.delete(subscriber);
        throw error;
      }
    } else {
      // 待機イベントのリプレイは `serverNow` が発行時点のままで、残り時間が過大になる。
      // retry のリプレイを含むときは、現在の serverNow を持つスナップショットで上書きする。
      let retryReplayed = false;
      for (const entry of record.events) {
        if (entry.seq <= cursor.seq) continue;
        send(entry);
        if (entry.type === "run_retry" && entry.data.retry !== null) retryReplayed = true;
      }
      if (retryReplayed) send({ seq: record.seq, type: "resync", data: this.payload(record), at: Date.now() });
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
      rootCwd: this.rootCwd,
    });
  }

  compactionsOf(record: SessionRecord): CompactionInfo[] {
    return compactionsOf(record, this.masker);
  }

  /** 全履歴のカーソルページ。切り出しと状態導出は history-projection の純関数が持つ */
  history(record: SessionRecord, options: { before?: string; limit?: number }) {
    return projectHistoryPage({
      record,
      masker: this.masker,
      cwd: workspaceAbs(this.rootCwd, record.workdir),
      ...options,
    });
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
      spaceId: meta.spaceId ?? "default",
      title: meta.title || "無題のセッション",
      agentId: meta.agentId,
      agentName: meta.agent.name,
      status: "idle",
      queueDepth: 0,
      notify: meta.notify === true,
      pinned: meta.pinned === true,
      messageCount: meta.messageCount,
      createdAt: meta.createdAt,
      lastUsedAt: meta.lastUsedAt,
      ...(meta.model ? { model: meta.model } : {}),
      ...(this.projectIdOfCwd(meta.projectCwd) ? { projectId: this.projectIdOfCwd(meta.projectCwd) } : {}),
    };
  }

  /** 一覧に出る会話のタイトル。未知の会話は undefined */
  titleOfId(id: string): string | undefined {
    return this.list().find((summary) => summary.sessionId === id)?.title;
  }

  /**
   * 会話の作業ディレクトリ (root 相対)。SDK セッションを開かずに解決する (serve の状態 API が
   * 閲覧中の会話から見た実績を引くために使う)。live でも descriptor でも同じ規則で、未知は undefined。
   */
  workdirOfId(id: string): string | undefined {
    const live = this.records.get(id);
    if (live) return live.workdir;
    const meta = this.descriptors.get(id);
    if (!meta) return undefined;
    return this.workdirOf(id, meta.projectCwd, meta.spaceId);
  }

  spaceOfId(id: string): string | undefined {
    const meta = this.records.get(id)?.meta ?? this.descriptors.get(id);
    return meta ? (meta.spaceId ?? "default") : undefined;
  }

  /** SessionPayload.cwd は rootCwd 相対。所属があれば登録ディレクトリ、未所属はスクラッチ (永続化なしは root) */
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
      const pendingPin = this.pinUpdates.get(id);
      if (pendingPin) await pendingPin.catch(() => {});
      const record = this.records.get(id);
      if (record) {
        record.queue = [];
        // 削除は finish を通らないため、回答待ちもここで取り消す (abort の signal に依存しない)
        this.cancelQuestions(record);
        // 先に task を持ち、abort の後にその settle を待つ (削除中の保存は persist のガードが no-op にする)
        const compaction = record.compactionTask;
        if (this.isBusy(record) || record.session.isStreaming) await record.session.abort().catch(() => {});
        await compaction?.catch(() => {});
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
  persist(record: SessionRecord, { jsonl = true }: { jsonl?: boolean } = {}): Promise<string | undefined> {
    if (!record.writer || !this.storeDir) return Promise.resolve(undefined);
    const storeDir = this.storeDir;
    const run = async (): Promise<string | undefined> => {
      // 削除済み・別世代に差し替わった record は書かない (store を復活させない)
      if (this.deleting.has(record.id) || this.records.get(record.id) !== record) return undefined;
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
      // record.meta の古い値を残さない (Off へ戻した会話が再起動で On に戻らないように)
      if (record.notify) meta.notify = true;
      else delete meta.notify;
      if (record.pinned) meta.pinned = true;
      else delete meta.pinned;
      record.meta = meta;
      this.descriptors.set(record.id, meta);
      // 今回の保存だけを評価する (過去の失敗は成功で消す)
      let failure: string | undefined;
      // writer へ渡すのと同じスナップショットを使う。await 中に SDK が追記した entry を
      // 保存済みとして対応表へ入れない (次の保存で書かれる)。run id は entry 自身へ写す
      const entries = this.annotateRunIds(record, entriesOf(session));
      try {
        await writeSessionMeta(storeDir, meta);
        if (jsonl) {
          await record.writer?.schedule(sessionHeaderOf(meta, workspaceAbs(this.rootCwd, record.workdir)), entries);
        }
      } catch (error) {
        failure = messageFor(error);
      }
      failure = failure ?? record.writer?.error;
      // JSONL に載った user entry だけを保存済みとして扱う (書けていない entry を対応表へ入れない)。
      // meta だけの保存 (jsonl: false) では entry の保存を確かめられないので触らない
      if (jsonl && !failure) this.syncSendMap(record, entries);
      // 送信対応記録は失敗しても dirty を残し、次の persist / flush でやり直す
      this.writeSends(record);
      record.persistError = failure;
      if (failure && record.persistErrorLogged !== failure) {
        record.persistErrorLogged = failure;
        console.warn(`[u7agent] セッションの保存に失敗しました (${record.id}): ${failure}`);
      }
      if (!failure) record.persistErrorLogged = undefined;
      return failure;
    };
    const next = record.persistTail.then(run, run);
    const result = next.catch((error: unknown) => {
      const failure = messageFor(error);
      record.persistError = failure;
      if (record.persistErrorLogged !== failure) {
        record.persistErrorLogged = failure;
        console.warn(`[u7agent] セッションの保存に失敗しました (${record.id}): ${failure}`);
      }
      return failure;
    });
    record.persistTail = result.then(() => {});
    return result;
  }

  async flush(record: SessionRecord): Promise<boolean> {
    await record.persistTail.catch(() => {});
    await record.writer?.flush();
    // 最後の persist で書けなかった送信対応記録をここでも試す (close / sweep の最終保存)
    return this.writeSends(record);
  }

  async sweep(): Promise<void> {
    if (this.sweeping || this.closing) return;
    this.sweeping = true;
    try {
      const cutoff = Date.now() - SESSION_TTL_MS;
      // 破棄中に records を変更するため、走査対象は先に固める
      for (const [id, record] of Array.from(this.records)) {
        if (this.isBusy(record) || record.subscribers.size > 0 || record.changingSettings) continue;
        if (this.deleting.has(id) || this.lifecycle.has(id) || this.pinUpdates.has(id)) continue;
        if (record.lastUsedAt >= cutoff) continue;
        const promise = (async () => {
          // 最終保存を試み、成功したときだけメモリから外す (失敗は次の sweep で再試行する)。
          // sends だけ失敗していても外さない (未送信の本文と再試行元を失わない)
          await this.persist(record);
          await this.flush(record);
          if (record.persistError || record.writer?.error || record.sendsError) return;
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
      (record) => record.persistError || record.writer?.error || record.sendsError,
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
    await Promise.allSettled(Array.from(this.pinUpdates.values()));
    await Promise.allSettled(Array.from(this.lifecycle.values()));
    for (const record of Array.from(this.records.values())) {
      // 先に task を持ち、abort の後にその settle を待つ (closing でも保存は行われ、終端配信と pump だけ止まる)
      const compaction = record.compactionTask;
      this.cancelQuestions(record);
      if (this.isBusy(record)) await record.session.abort().catch(() => {});
      await compaction?.catch(() => {});
      await this.flush(record);
      record.session.dispose?.();
    }
    this.records.clear();
  }

  /** バックグラウンドランを開始する (呼び出し側はセッションが idle であることを保証する)。 */
  startRun(record: SessionRecord, text: string, presetId?: string): RunState {
    const { session } = record;
    const run: RunState = {
      // キューから始まる run は受け付けた時点で振った id を使う (応答で返した id と一致させる)
      id: presetId ?? randomBytes(8).toString("hex"),
      // ログ・SSE 用に保持するプロンプトはマスクする (モデルへ渡す text はユーザー入力そのまま)。
      prompt: this.masker.mask(text),
      status: "running",
      startedAt: Date.now(),
      endedAt: undefined,
      error: undefined,
      errorCode: undefined,
      totalRetryCount: 0,
    };
    record.run = run;
    record.tools = new Map();
    // 質問の待機も run と同じ寿命。前の run の tombstone (回答済み) を次の run へ持ち越さない
    record.questions = new Map();
    record.lastUsedAt = Date.now();
    this.emit(record, "run_start", { runId: run.id, prompt: run.prompt, startedAt: run.startedAt });

    let finished = false;

    /** run.retry のスナップショットを SSE へ配る。run はこのランを閉じるまで差し替わらない */
    const emitRetry = (): void => {
      this.emit(record, "run_retry", {
        retry: run.retry ? { ...run.retry } : null,
        totalRetryCount: run.totalRetryCount,
        serverNow: Date.now(),
      });
    };

    const finish = ({ error, stopped = false }: RunSettlement = {}): void => {
      if (finished) return;
      finished = true;

      // listener 例外 / prompt() reject で終わる経路も含めて、未 settle の待機を必ず取り消す
      this.cancelQuestions(record);

      // 保留中の差分・最終テキスト・送信メッセージ待ちの resync は run_end より先に配る
      bridge.finalize();

      // 待機中の中止は aborted の assistant が投影に残らないため、stop の要求を停止の正とする
      const wasStopped = stopped || run.stopRequested === true;
      run.status = wasStopped ? "stopped" : error ? "error" : "completed";
      const endedAt = Date.now();
      run.endedAt = endedAt;
      // アクティブな再試行は終了で消す。累計は結果表示のため残す
      delete run.retry;
      if (error) run.error = this.masker.mask(composeRunError(error, run.totalRetryCount));
      // 分類コードは最終失敗のときだけ公開する。停止要求と例外が同時なら status は stopped で、
      // クライアントに再実行カードを出させない (run.error は従来どおり残す)
      if (run.status === "error" && error) run.errorCode = error.code;
      // 一覧 API / meta と同じ表示メッセージ数。ここを履歴の生件数 (session.messages.length) へ
      // 戻すと同名フィールドの定義が 2 つに戻る
      const messages = displayableMessages(session, this.masker);
      this.emit(record, "run_end", {
        runId: run.id,
        status: run.status,
        // 完了の合計時間。キュー待ちは含めず、実際に走ったぶんだけを測る
        durationMs: endedAt - run.startedAt,
        error: run.error,
        errorCode: run.errorCode,
        messageCount: messages.length,
        queueDepth: record.queue.length,
        totalRetryCount: run.totalRetryCount,
        // SDK は message_end をリスナーへ配ってから履歴へ入れるため、usage イベントの context は
        // 直前の応答までの値になる (compaction 直後は不明値のまま)。ここでは履歴反映済みの値を配る。
        context: contextUsageOf(session),
      });
      // 最後の assistant entry を取りこぼさないよう、ラン終了時に必ず保存する
      void this.persist(record).then(() => {
        // user entry を残さずに終わった run (認証エラー等) は、購読者へ未送信として配る。
        // 通常は user entry の保存で記録が消えるため、ここへ来るのは保存されなかった run だけ
        if (this.records.get(record.id) !== record) return;
        if (record.unsentSends.some((item) => item.runId === run.id)) this.emitResync(record);
      });

      // 送信は fire-and-forget。run_end の記録・persist・キューの pump を待たせない
      this.notifyCompleted(record, run, bridge.settledAssistantText());

      if (record.queue.length > 0) {
        setTimeout(() => this.pump(record), QUEUE_DELAY_MS).unref?.();
      }
    };

    const bridge = createRunEventBridge({
      session,
      masker: this.masker,
      // 履歴側と同じ絶対 cwd。root 相対と絶対を混ぜると解決結果が経路でずれる
      cwd: workspaceAbs(this.rootCwd, record.workdir),
      tools: record.tools,
      toolTimings: record.toolTimings,
      messageMetrics: record.messageMetrics,
      compactionMeta: record.compactionMeta,
      emit: (type, data) => this.emit(record, type, data),
      // 遅延した resync (context_edit の microtask) が次のランへ漏れないよう、ラン ID を確認してから配る
      emitResync: () => {
        if (record.run === run && run.status === "running") this.emitResync(record);
      },
      // SDK は listener 通知の後に entry を append する。1 拍置いてから読む (保存点の順序テストあり)
      onPersist: () => queueMicrotask(() => void this.persist(record)),
      // 履歴 item に run id を写すための控え。SDK は listener の後に entry を append するが、
      // entry と session.messages は同じメッセージ参照を共有するので、投影時に参照で引ける
      onPromptMessage: (message) => {
        record.userMessageRuns.set(message, run.id);
      },
      onRetryScheduled: ({ attempt, maxAttempts, delayMs, errorMessage }) => {
        run.totalRetryCount += 1;
        const reason = classifyRunError(errorMessage)?.code ?? "unknown";
        run.retry = {
          phase: "waiting",
          attempt,
          maxAttempts,
          retryAt: Date.now() + Math.max(0, delayMs),
          reason,
        };
        emitRetry();
        this.emit(record, "status", {
          state: "retry",
          text: retryWaitingText(reason, attempt, maxAttempts, delayMs),
        });
      },
      onRetryAttemptStart: () => {
        if (!run.retry) return;
        run.retry = {
          phase: "retrying",
          attempt: run.retry.attempt,
          maxAttempts: run.retry.maxAttempts,
          reason: run.retry.reason,
        };
        emitRetry();
        this.emit(record, "status", {
          state: "retry",
          text: `再実行中（${run.retry.attempt}/${run.retry.maxAttempts}）`,
        });
      },
      onRetryEnd: () => {
        if (!run.retry) return;
        delete run.retry;
        emitRetry();
      },
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
        if (!finished) finish({ error: classifyRunError(error) });
        unsubscribe();
      });

    return run;
  }

  /**
   * 完了通知。送信は fire-and-forget で、失敗してもランとその記録に影響させない。
   * 送るかどうかは finish 時点の値で決め、本文はこのランで確定したものだけを使う
   * (履歴を遡ると、assistant を生成しなかったランで前の応答を再送してしまう)。
   */
  private notifyCompleted(record: SessionRecord, run: RunState, body: string | undefined): void {
    if (!this.notifications || run.status !== "completed" || !record.notify) return;
    if (!body?.trim()) return;
    this.notifications.notifySession({
      sessionId: record.id,
      title: record.title,
      agentName: record.agent.name,
      body,
      durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
      toolCalls: record.tools.size,
    });
  }

  pump(record: SessionRecord): void {
    if (this.deleting.has(record.id) || this.records.get(record.id) !== record) return;
    // 圧縮の終端処理が done してから呼ばれる (圧縮中はキューを進めない)
    if (record.compacting) return;
    if (record.queue.length === 0) return;
    if (record.run?.status === "running" || record.session.isStreaming) return;
    const next = record.queue.shift();
    if (next === undefined) return;
    record.lastUsedAt = Date.now();
    this.startRun(record, next.text, next.runId);
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
