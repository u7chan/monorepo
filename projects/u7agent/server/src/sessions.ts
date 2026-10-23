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
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { spaceIdOf } from "./spaces";
import { sessionUploadsRel, workspaceAbs } from "./app-paths";
import { SANDBOX_NOT_CONFIGURED_MESSAGE, type PiBff } from "./agent";
import { composePromptSnapshot } from "./agent";
import { buildHandoffSection, HANDOFF_FILE_NAME, type HandoffMemoSection } from "./handoff-memo";
import type { CwdKeyStore } from "./app-db";
import { sandboxFailureStatus } from "./http";
import type { AgentCatalog } from "./agents";
import { createInvestigateRunner, type InvestigateRunner } from "./investigate-runner";
import type { InvestigateHost } from "./investigate-tool";
import { validateAskUserAnswers, type AskUserHost } from "./ask-user-tool";
import { stripAttachedFiles } from "./attachments";
import { compactionsOf, recordCompactionOutcome } from "./compaction-view";
import { projectSessionDiagnostics } from "./diagnostics";
import { projectHistoryPage } from "./history-projection";
import type { NotificationService } from "./notifications";
import { contextUsageOf, type PiRuntimeLike, type PiSessionEvent, type PiSessionLike } from "./pi-runtime";
import type { ProjectStore } from "./projects";
import { createSecretMasker, type SecretMasker } from "./redact";
import { classifyRunError, composeRunError, retryWaitingText } from "./error-classify";
import { createRunEventBridge, type RunSettlement } from "./run-events";
import { runDurationMs } from "./run-metrics";
import type {
  CreateSessionOptions,
  PendingQuestion,
  PostMessageResultInternal,
  QueuedSend,
  RunState,
  SessionRecord,
  SessionSubscriber,
  UpdateSessionSettingsInput,
} from "./session-record";
import { projectSessionPayload, projectSessionSummary } from "./session-payload";
import { batchesSteering, sdkQueueLength, takenSendIdsOf } from "./session-steering";
import { SANDBOX_MAX_HANDOFF_BYTES } from "./sandbox/protocol";
import { RunOutcomeSchema } from "./schema";
import { displayableMessages, truncate } from "./session-projection";
import type { SandboxHandoffClient, SandboxMoveClient, SandboxWorkspaceClient } from "./sandbox/client";
import { SandboxRequestError } from "./sandbox/client";
import {
  SessionDamagedError,
  SessionFileWriter,
  emptySessionSends,
  generateHandoffOperationId,
  generateSessionId,
  listSessionIds,
  prepareSessionStore,
  readSessionFile,
  readSessionMeta,
  entrySendsFromJsonl,
  readSessionSends,
  removeSessionDir,
  removeSessionHistory,
  sessionHeaderOf,
  sessionJsonlPath,
  sessionWorkdirRel,
  writeSessionMeta,
  RUN_ID_FIELD,
  ASSISTANT_ID_FIELD,
  SEND_ID_FIELD,
  writeSessionSends,
  type PromptSnapshot,
  type SessionEntryLike,
  type SessionHandoffRecord,
  type SessionMeta,
  type SessionSends,
} from "./session-store";
import type {
  AgentDef,
  AgentPayloadInfo,
  AskUserAnswer,
  AskUserQuestion,
  CompactionInfo,
  EventEntry,
  ModelRef,
  Project,
  ResyncReason,
  RunStatus,
  SessionCompactionResult,
  SessionDiagnostics,
  SessionMoveResponse,
  SessionNotifyResponse,
  SessionPinnedResponse,
  SessionPayload,
  SessionSummary,
  SessionTitleResponse,
  SSEEventData,
  SSEEventType,
  ThinkingLevel,
} from "./schema";

const MAX_EVENT_LOG = 2000;
const MAX_QUEUE_DEPTH = 10;
const QUEUE_DELAY_MS = 200;
const SESSION_TTL_MS = 60 * 60 * 1000;
/**
 * 終了行を実行状況へ残す長さ。sweep はこの間だけ終了済みの live レコードを残し、画面も同じ長さで切る。
 * `SESSION_TTL_MS` は変えない (保持はメモリ内だけで、BFF 再起動をまたぐ台帳にはしない)。
 */
export const FINISHED_RETENTION_MS = 120 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const TITLE_MAX = 60;
/** 引き継ぎの片付け (確定後に残った履歴の削除) が済んでいない会話の共通文言 */
const HANDOFF_CLEANUP_PENDING_MESSAGE =
  "前回の引き継ぎの片付けが残っています。会話を開いてから、もう一度お試しください";

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
  /** 引っ越しで作業フォルダ / 添付を移すサンドボックス。未指定は移動を 503 にする (workspace スタブを広げない) */
  moveSandbox?: SandboxMoveClient | null;
  /** 引き継ぎメモ (HANDOFF.md) の読み書き。未指定は引き継ぎを 503 にする (同じくスタブを広げない) */
  handoffSandbox?: SandboxHandoffClient | null;
  /** cwd をキーにする行 (secrets / serve_commands) の付け替え。未指定は付け替えない (テスト) */
  cwdKeys?: CwdKeyStore | null;
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
 * セッション作成時に固定するエージェントのスナップショット (表示用情報 + プロンプトスナップショット)。
 * 作成と、セッション未確定のプレビュー (GET /api/skills/session) で同じ索引を組むため共有する。
 * 未知の id は 400。スキルの現行定義はファイル側で、ここには割り当てを固定しない。
 */
export function resolveAgentSkills(
  catalog: AgentCatalog,
  agentId?: string,
): {
  agent: AgentDef;
  agentInfo: AgentPayloadInfo;
  promptSnapshot: PromptSnapshot;
} {
  const selectedAgentId = agentId || catalog.builtinAgent().id;
  const agent = selectedAgentId ? catalog.getAgent(selectedAgentId) : undefined;
  if (!agent) throw httpError(400, "Agent not found");
  return {
    agent,
    agentInfo: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      // 未指定のときはキーを省略する (`[]` = すべて OFF は落とさない)
      ...(agent.commonSkillNames === undefined ? {} : { commonSkillNames: [...agent.commonSkillNames] }),
      ...(agent.builtinSkillNames === undefined ? {} : { builtinSkillNames: [...agent.builtinSkillNames] }),
      ...(agent.toolNames === undefined ? {} : { toolNames: [...agent.toolNames] }),
    },
    promptSnapshot: composePromptSnapshot(agent),
  };
}

/**
 * 進行中の引っ越し 1 件。同じ会話に複数が重なると移動先が違うことがあるため、会話 ID ではなく
 * 操作単位で持ち、後続の登録が先行の待機対象を隠さないようにする。
 */
interface PendingMove {
  /** 移動先スペース */
  spaceId: string;
  /** この操作の完了 (完了 / ロールバック) を待つ promise */
  settled: Promise<void>;
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
  /** 引っ越しの物理移動に使う。null は移動を 503 にする */
  moveSandbox: SandboxMoveClient | null;
  /** 引き継ぎメモ (HANDOFF.md) の読み書きに使う。null は引き継ぎを 503 にする */
  handoffSandbox: SandboxHandoffClient | null;
  /** 引っ越しで cwd をキーにする行を付け替えるアプリ DB。null は付け替えない */
  cwdKeys: CwdKeyStore | null;
  rootCwd: string;
  /** ストア上のメタデータ。live な record の分も持つ */
  descriptors: Map<string, SessionMeta>;
  /** id ごとのライフサイクル (load / evict)。完了まで同じ id の再ロードを待たせる */
  lifecycle: Map<string, Promise<unknown>>;
  /** 未ロード会話の meta-only 更新。タイトル・通知・ピン間で保存コピーを直列化する */
  metaUpdates: Map<string, Promise<void>>;
  /** 同一会話のピン更新。save / restore / delete と競合しないよう直列化する */
  pinUpdates: Map<string, Promise<void>>;
  /** 削除予約中の id */
  deleting: Set<string>;
  /**
   * 引き継ぎの消費済み印の保存 (記録ごと)。進行中の保存を後続の受理も待ち、成功した印は待たせず、
   * 失敗した印は次の受理でやり直す (未保存のまま 202 を返さない)。
   */
  private handoffSaves: WeakMap<
    SessionRecord,
    { operationId: string; saving: Promise<string | undefined>; failed: boolean }
  >;
  /** in-flight の引っ越し (操作単位)。対象スペースの削除が根を消す前に待つ相手を引く */
  private pendingMoves: Set<PendingMove>;
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
  /** investigate の子 runner。子は record に載せず、並列と待ち行列の在庫をここに持つ */
  investigator: InvestigateRunner;

  constructor({
    pi,
    catalog,
    masker,
    projects,
    storeDir,
    storeError,
    workspace,
    moveSandbox,
    handoffSandbox,
    cwdKeys,
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
    this.moveSandbox = moveSandbox ?? null;
    this.handoffSandbox = handoffSandbox ?? null;
    this.cwdKeys = cwdKeys ?? null;
    this.rootCwd = rootCwd ?? process.cwd();
    this.notifications = notifications ?? null;
    this.writeSendsFile = writeSends ?? writeSessionSends;
    this.investigator = createInvestigateRunner({
      masker: this.masker,
      // 子モードの固定はここが持つ (ツール定義と runner は mode を知らない)
      createChildSession: async (input) => {
        const pi = this.pi;
        if (!pi) throw new Error("ランタイムを利用できません");
        const created = await pi.createSession({
          mode: "investigation",
          agent: input.agent,
          cwd: input.cwd,
          ...(input.model ? { model: input.model } : {}),
          // 親の許可リストは子にも渡す (子経由で外したツールを実行させない)。子の集合はこの許可リストと
          // 読み取り専用の集合との積で、createSession 側が決める
          ...(input.toolNames === undefined ? {} : { toolNames: [...input.toolNames] }),
          ownerSessionId: input.ownerSessionId,
        });
        return created.session as PiSessionLike;
      },
    });
    this.records = new Map();
    this.descriptors = new Map();
    this.lifecycle = new Map();
    this.metaUpdates = new Map();
    this.pinUpdates = new Map();
    this.deleting = new Set();
    this.handoffSaves = new WeakMap();
    this.pendingMoves = new Set();
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
    const { agent, agentInfo, promptSnapshot } = resolveAgentSkills(this.catalog, agentId);
    const id = this.storeDir ? generateSessionId(this.storeDir) : randomBytes(5).toString("hex");
    // 所属セッションの cwd は登録ディレクトリそのもの。プロジェクトのディレクトリは作らず存在だけ確かめる。
    // スクラッチを作るのは未所属だけ (永続化なしでは作業フォルダのライフサイクルを持たない)
    const workdir = this.workdirOf(id, project?.cwd, spaceId);
    if (this.storeDir || spaceId !== "default") {
      if (project) await this.requireProjectDir(project.cwd);
      else await this.ensureWorkdir(workdir);
    }
    const created = await this.pi.createSession({
      agent: { ...agent },
      // 共通スキルの許可リストは注入経路 (skillsOverride) にも渡す (一覧と /skill: の解決と揃える)
      ...(agentInfo.commonSkillNames === undefined ? {} : { commonSkillNames: agentInfo.commonSkillNames }),
      // 組み込みスキルの許可リストも同じく注入経路・read の横取り・system prompt の案内へ渡す
      ...(agentInfo.builtinSkillNames === undefined ? {} : { builtinSkillNames: agentInfo.builtinSkillNames }),
      // ツールの許可リストも作成時に確定して meta へ保存する (復元はこれをスナップショットとして使う)
      ...(agentInfo.toolNames === undefined ? {} : { toolNames: agentInfo.toolNames }),
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
      assistantMessageIds: new WeakMap(),
      userMessageSends: new WeakMap(),
      entrySends: new Map(),
      runInitialSends: new Map(),
      injectedSends: new Set(),
      stopping: false,
      cancelling: 0,
      unsentSends: [],
      sendsDirty: false,
      compactionMeta: new Map(),
      runOutcomes: new Map(),
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
   * セッションの作業ディレクトリ (root 相対)。所属があれば登録ディレクトリ、無ければ所属スペースの
   * スクラッチ。root ("") になるのは永続化なしの既定スペースだけ (既存のテスト・未設定デプロイ)。
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
      const pending = this.lifecycle.get(id) ?? this.metaUpdates.get(id) ?? this.pinUpdates.get(id);
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
    // 引き継ぎの確定後に残った履歴は、SDK セッションを作る前に片付ける。削除に失敗し続ける間は
    // 開く要求を 409 で拒否し、一覧には残す (DELETE は可能)。
    let current = meta;
    if (meta.handoffCleanup) {
      try {
        await removeSessionHistory(this.storeDir as string, id);
      } catch (error) {
        throw httpError(409, `引き継ぎの片付けが残っています。会話履歴を削除できませんでした: ${messageFor(error)}`);
      }
      current = { ...meta };
      delete current.handoffCleanup;
      this.descriptors.set(id, current);
    }
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
    const workdir = this.workdirOf(id, current.projectCwd, current.spaceId);
    if (!current.projectCwd) await this.ensureWorkdir(workdir);
    const restored = this.restoreInputs(current, entries);
    const created = await (this.pi as PiRuntimeLike).createSession({
      sessionId: id,
      ownerSessionId: id,
      entries,
      promptSnapshot: current.promptSnapshot,
      // 共通スキルの許可リストも meta のスナップショットから渡す (定義編集を遡及させない)
      ...(current.agent.commonSkillNames === undefined ? {} : { commonSkillNames: current.agent.commonSkillNames }),
      // 組み込みスキルの許可リストも同じく meta のスナップショットから渡す
      ...(current.agent.builtinSkillNames === undefined ? {} : { builtinSkillNames: current.agent.builtinSkillNames }),
      // ツールの許可リストも定義を引き直さず、セッションのスナップショットから渡す
      ...(current.agent.toolNames === undefined ? {} : { toolNames: current.agent.toolNames }),
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
      spaceId: current.spaceId ?? "default",
      id,
      session,
      agentId: current.agentId,
      agent: current.agent,
      promptSnapshot: current.promptSnapshot,
      workdir,
      project: undefined,
      title: current.title,
      createdAt: current.createdAt,
      notify: current.notify === true,
      pinned: current.pinned === true,
    });
    record.lastUsedAt = current.lastUsedAt;
    record.meta = current;
    // 所属は保存値から復元し、projectId だけを読み取り時に解決する
    record.projectCwd = current.projectCwd;
    record.projectName = current.projectName;
    record.projectId = this.projectIdOfCwd(current.projectCwd);
    // 送信対応は JSONL の entry へ写した注記を正とする (entry の存在が証跡なので、本文や時刻での
    // 推測をしない)。未送信の記録は、その注記に載っている送信だけを保存済みとして外す
    const sends = this.storeDir ? readSessionSends(this.storeDir, id) : emptySessionSends();
    record.entrySends = entrySendsFromJsonl(entries);
    // 再起動後の payload.messages も保存済みの応答IDで対応付ける
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message as { role?: unknown } | undefined;
      const assistantId = entry[ASSISTANT_ID_FIELD];
      if (message?.role === "assistant" && typeof assistantId === "string" && assistantId !== "") {
        record.assistantMessageIds.set(message, assistantId);
      }
      const entryId = entry.id;
      const send = typeof entryId === "string" ? record.entrySends.get(entryId) : undefined;
      if (message?.role === "user" && send !== undefined) record.userMessageSends.set(message, send);
    }
    const persistedIds = new Set(
      [...record.entrySends.values()].flatMap((send) => [send.sendId, ...(send.runId ? [send.runId] : [])]),
    );
    record.unsentSends = sends.unsent.filter((item) => !persistedIds.has(item.sendId));
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
    const backfillCount =
      current.messageCount !==
      displayableMessages(session, this.masker, workspaceAbs(this.rootCwd, record.workdir)).length;
    if (modelRecorded) await this.persist(record);
    else if (backfillCount || meta.handoffCleanup) await this.persist(record, { jsonl: false });
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

  private async queueMetaUpdate<T>(id: string, update: () => Promise<T>): Promise<T> {
    const previous = this.metaUpdates.get(id) ?? Promise.resolve();
    const operation = previous.then(update);
    const settled = operation.then(
      () => {},
      () => {},
    );
    this.metaUpdates.set(id, settled);
    try {
      return await operation;
    } finally {
      if (this.metaUpdates.get(id) === settled) this.metaUpdates.delete(id);
    }
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
    return this.queueMetaUpdate(id, async () => {
      if (this.deleting.has(id) || this.closing) return undefined;
      const meta = this.descriptors.get(id);
      if (!meta || !this.storeDir) return undefined;
      const updated: SessionMeta = { ...meta };
      if (notify) updated.notify = true;
      else delete updated.notify;
      const storeDir = this.storeDir;
      // 古い descriptor を独立保存して後続更新を消さないよう、直列化後に最新値を読む。
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
    });
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
    return this.queueMetaUpdate(id, async () => {
      if (this.deleting.has(id) || this.closing) return undefined;
      const meta = this.descriptors.get(id);
      if (!meta || !this.storeDir) return undefined;
      const updated: SessionMeta = { ...meta };
      if (pinned) updated.pinned = true;
      else delete updated.pinned;
      const storeDir = this.storeDir;
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
    });
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
    return this.queueMetaUpdate(id, async () => {
      if (this.deleting.has(id) || this.closing) return undefined;
      const meta = this.descriptors.get(id);
      if (!meta || !this.storeDir) return undefined;
      const updated: SessionMeta = { ...meta, title: next };
      const storeDir = this.storeDir;
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
    });
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
  emitResync(record: SessionRecord, reason?: ResyncReason): SessionPayload {
    const payload = this.payload(record);
    payload.lastSeq = record.seq + 1;
    if (reason !== undefined) payload.resyncReason = reason;
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
   * 実行中なら追加入力としてBFFの配送キューへ積み、それ以外は即座にランを始める。`titleSource` は
   * 一覧のタイトルの元本文で、省略時は text。`/skill:` の展開結果は長いため、展開前のユーザー入力から
   * タイトルを作るために使う。`sendId` は未送信メッセージの再送で、受理済みの送信IDを引き継ぐ。
   */
  postMessage(
    record: SessionRecord,
    text: string,
    options: { titleSource?: string; sendId?: string } = {},
  ): PostMessageResultInternal {
    // 設定変更・停止処理中の送信は 409 (BFF のルートでも同じ扱い)
    if (record.changingSettings) {
      throw httpError(409, "Session settings are being changed");
    }
    if (record.stopping) {
      throw httpError(409, "Session is stopping");
    }
    // 圧縮中も送信はキューへ積む (排他の正は BFF の flag。SDK は保存待ちの間 idle に見える)
    const runActive = this.runInProgress(record) || record.compacting;
    // 終端で回収した入力が配送に残っている間も、新しい送信が先に始まらないよう待機へ積む
    const waiting = runActive || record.queue.length > 0;
    if (waiting && record.queue.length >= MAX_QUEUE_DEPTH) {
      throw httpError(429, `Message queue is full (max ${MAX_QUEUE_DEPTH})`);
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
    // 送信IDはキュー受付 / 即時開始のどちらでも先に振る。エントリ保存前に落ちた送信を「未送信」として
    // 残す記録にも同じ id を使うため、startRun に渡す前にここで確定させる
    const sendId = options.sendId ?? randomBytes(8).toString("hex");

    if (waiting) {
      this.rememberUnsent(record, sendId, text);
      // 再送で前回の実行への割当が残っていても、待機に戻した時点で外す (次の実行で割り当て直す)
      const pending = record.unsentSends.find((item) => item.sendId === sendId);
      if (pending?.runId !== undefined) {
        delete pending.runId;
        record.sendsDirty = true;
        this.writeSends(record);
      }
      const entry: QueuedSend = { sendId, text, at: Date.now() };
      record.queue.push(entry);
      // 実行が無くても古い配送待ちが残っていれば、新規送信が追い越さないよう先頭から開始する
      if (!runActive) this.pump(record);
      // 待機の順位と件数は BFF と SDK の未注入分を合わせて数える (SDK へ渡した分も queue に残る)
      this.emit(record, "queued", {
        position: record.queue.findIndex((item) => item.sendId === sendId) + 1,
        queueDepth: record.queue.length,
        sendId,
        prompt: this.masker.mask(text),
      });
      // 実行中の最初の user が注入済みなら、そのまま steering として SDK へ渡す
      this.deliverSteering(record);
      return { queued: true, queueDepth: record.queue.length, sendId, ...this.consumeHandoff(record) };
    }

    // 実行IDは開始前に振り、受理記録へ一緒に書く (未送信の記録を 2 回書かない)
    const runId = randomBytes(8).toString("hex");
    this.rememberUnsent(record, sendId, text, runId);
    const run = this.startRun(record, text, sendId, runId);
    return { queued: false, queueDepth: 0, sendId, runId: run.id, ...this.consumeHandoff(record) };
  }

  /**
   * 未送信メッセージの再送。保存済みの生の本文を使い、同じ送信IDで実行し直す (受理の記録は
   * そのまま。user entry が保存された時点で `syncSendMap` が消す)。二重の再送は待機 / 実行 /
   * 注入済みの送信IDを見て弾く。見つからない送信IDは undefined (既に保存済みか破棄済み)。
   */
  resend(record: SessionRecord, sendId: string): PostMessageResultInternal | undefined {
    const send = record.unsentSends.find((item) => item.sendId === sendId);
    if (!send) return undefined;
    if (this.isSendActive(record, sendId)) {
      // 二重の再送は重ねない。状態は既に配られているので resync も足さない
      const queued = record.queue.find((item) => item.sendId === sendId);
      const runId =
        queued?.runId ??
        (record.run?.initialSendId === sendId ? record.run.id : undefined) ??
        record.unsentSends.find((item) => item.sendId === sendId)?.runId;
      return {
        queued: queued !== undefined,
        queueDepth: record.queue.length,
        sendId,
        ...(runId === undefined ? {} : { runId }),
      };
    }
    const result = this.postMessage(record, send.text, { sendId });
    // 別タブの未送信表示を更新する。即時開始の run_start は run id を配るが、キュー受付の `queued` は配らない
    this.emitResync(record);
    return result;
  }

  /**
   * 未送信メッセージの破棄。"missing" は記録が無い (再送済み / 別タブで破棄済み)、"running" は
   * 配送中 / 実行中 / 注入済みで消せないことを表す。破棄は購読者へ resync で配る (別タブの
   * 未送信バブルを消すため)。
   */
  discardUnsent(record: SessionRecord, sendId: string): "ok" | "missing" | "running" {
    const index = record.unsentSends.findIndex((item) => item.sendId === sendId);
    if (index === -1) return "missing";
    if (this.isSendActive(record, sendId)) return "running";
    record.unsentSends.splice(index, 1);
    record.sendsDirty = true;
    this.writeSends(record);
    this.emitResync(record);
    return "ok";
  }

  /**
   * 待機中の 1 件だけを配送から外して未送信へ戻す。実行中のターンは止めず、他の入力も破棄しない。
   * BFF が持つ分はそのまま外し、SDK へ渡した分は一括ドレインでしか捨てられないため、`taken` の
   * 判定から `clearQueue()` までを同期で行い、残りは以降に渡し直す。取り出されていれば 409。
   * 記録を残せない構成では取消の事後条件 (未送信として見える) を満たせないため、配送を触らない。
   */
  async cancelQueued(record: SessionRecord, sendId: string): Promise<"ok" | "running" | "unstorable" | "missing"> {
    const index = record.queue.findIndex((item) => item.sendId === sendId);
    if (index === -1) return this.isSendActive(record, sendId) ? "running" : "missing";
    if (!record.writer || !this.storeDir) return "unstorable";
    // 取消は直列化する (並行取消で `clearQueue()` が他の対象まで消さないように)。開始時点で
    // 新規配送と pump を止め、実際の処理は直前の取消の後ろへ積む
    record.cancelling += 1;
    const task = (record.cancelTask ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        try {
          return await this.cancelQueuedEntry(record, sendId);
        } finally {
          record.cancelling -= 1;
          if (record.cancelling === 0) {
            // 取消中に届いた待機を渡し直し、実行が無ければ次の実行を予約する
            this.deliverSteering(record);
            if (record.queue.length > 0 && !this.runInProgress(record)) {
              setTimeout(() => this.pump(record), QUEUE_DELAY_MS).unref?.();
            }
          }
        }
      });
    record.cancelTask = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  /** 取消 1 件分。受付チェーンの完了を待ってから、実キューと BFF の待機を揃えて外す */
  private async cancelQueuedEntry(record: SessionRecord, sendId: string): Promise<"ok" | "running" | "missing"> {
    // SDK の受付処理が進行中なら、その完了を待ってから実キューと taken の状態を判定する
    await record.steerTask?.catch(() => {});
    // 取消と注入の競合で状態が変わっていないか、await の後にもう一度引く
    const current = record.queue.find((item) => item.sendId === sendId);
    if (current === undefined) return this.isSendActive(record, sendId) ? "running" : "missing";
    if (current.handedOff === true) {
      if (batchesSteering(record)) {
        // 実キューは一括でしか捨てられない。taken の判定から clearQueue までに await を挟むと、
        // 取り消せないものを取り消せたと返すため、ここは同期で閉じる
        const taken = takenSendIdsOf(record);
        if (taken.has(current.sendId)) return "running";
        if (current.steered === true) {
          record.session.clearQueue?.();
          // 実キューに残っていた分だけを BFF の配送へ戻し、以降で渡し直す。ドレイン済み (taken) は
          // SDK がこれから注入するため、渡し直すと二重注入になる
          for (const entry of record.queue) {
            if (entry.handedOff === true && entry.steered === true && !taken.has(entry.sendId)) {
              this.releaseSteering(record, entry);
            }
          }
        }
      } else if (sdkQueueLength(record) === 0) {
        // 渡した 1 件が実キューに残っていなければ SDK が取り出している (注入前でも取消は 409)
        return "running";
      } else {
        record.session.clearQueue?.();
      }
    }
    this.detachQueued(record, current);
    // 取り消した分の順位と件数を別タブへ揃える
    this.emitResync(record);
    return "ok";
  }

  /**
   * 引き継ぎ後に最初に受理した送信で「消費済み」を立てる。未送信の破棄では戻さず、その場で meta へ
   * 保存する (BFF の再起動後も同じ判定になる)。購読者へは resync を配り、チップをその場で消す。
   *
   * 保存は「立てたがまだ載っていない」間を記録ごとに共有する。進行中の保存を後続の受理 (別タブ /
   * 再送) も待ち、失敗したら記録を外して次の受理でやり直す (未保存のまま 202 を返さない)。
   */
  private consumeHandoff(record: SessionRecord): { handoffSaving?: Promise<string | undefined> } {
    const handoff = record.meta.handoff;
    if (!handoff) return {};
    const last = this.handoffSaves.get(record);
    // 同じ印の保存が進行中、または成功済み。後続も同じ Promise を待つ (失敗した印はやり直す)
    if (last?.operationId === handoff.operationId && !last.failed) return { handoffSaving: last.saving };
    // ディスクに載っている印 (読み込み直した記録 / 別の引き継ぎの記録) は書き直さない
    if (handoff.consumed && last?.operationId !== handoff.operationId) return {};
    return { handoffSaving: this.saveHandoffConsumed(record, handoff.operationId) };
  }

  /** 消費済み印の保存 1 回分。失敗は記録に印を付け、次の受理にやり直させる */
  private saveHandoffConsumed(record: SessionRecord, operationId: string): Promise<string | undefined> {
    const handoff = record.meta.handoff;
    if (handoff && !handoff.consumed) {
      record.meta = { ...record.meta, handoff: { ...handoff, consumed: true } };
      this.descriptors.set(record.id, record.meta);
      this.emitResync(record);
    }
    const entry = { operationId, failed: false, saving: Promise.resolve<string | undefined>(undefined) };
    entry.saving = this.persist(record, { jsonl: false }).then((failure) => {
      entry.failed = failure !== undefined;
      return failure;
    });
    this.handoffSaves.set(record, entry);
    return entry.saving;
  }

  /** 実行が継続中か (開始送信の準備中と、終端処理が済む前の SDK idle も含む) */
  private runInProgress(record: SessionRecord): boolean {
    return record.run?.status === "running" || record.session.isStreaming;
  }

  /** その送信がまだ配送中 / 実行中 / 注入済みか。終了して未保存の送信は再送 / 破棄を妨げない */
  private isSendActive(record: SessionRecord, sendId: string): boolean {
    if (record.queue.some((item) => item.sendId === sendId)) return true;
    if (record.injectedSends.has(sendId)) return true;
    return record.run?.initialSendId === sendId && record.run.status === "running";
  }

  /**
   * SDK へ渡した待機の先頭。一括ドレインを持たない SDK では、実キューから取り出されたかを
   * この 1 件だけで見る
   */
  private steeringOf(record: SessionRecord): QueuedSend | undefined {
    return record.queue.find((item) => item.handedOff === true);
  }

  /**
   * その run へ今 steering を渡せるか。終端処理・取消・停止中の窓を取りこぼさないよう、
   * 実行の同一性と実キューへ積める状態 (streaming か isIdle でない) を毎段で見直す
   */
  private canDeliverSteering(record: SessionRecord, run: RunState): boolean {
    if (record.run !== run || run.status !== "running") return false;
    if (record.stopping || record.cancelling > 0 || record.compacting) return false;
    return record.session.isIdle === false || record.session.isStreaming;
  }

  /** 送信の実行への所属を控える (注入で確定した時点と、開始送信の即時開始で使う) */
  private assignSendRun(record: SessionRecord, sendId: string, runId: string): void {
    const send = record.unsentSends.find((item) => item.sendId === sendId);
    if (send && send.runId !== runId) {
      send.runId = runId;
      record.sendsDirty = true;
      this.writeSends(record);
    }
    const queued = record.queue.find((item) => item.sendId === sendId);
    if (queued) queued.runId = runId;
  }

  /**
   * BFF の待機から外し、未送信として残す (次の実行へは自動で再投入しない)。実行への割当も外す。
   * 保存は呼び出し側がまとめて 1 回行う
   */
  private detachQueued(record: SessionRecord, entry: QueuedSend): void {
    const position = record.queue.indexOf(entry);
    if (position !== -1) record.queue.splice(position, 1);
    delete entry.handedOff;
    delete entry.steered;
    delete entry.runId;
    const send = record.unsentSends.find((item) => item.sendId === entry.sendId);
    if (send) {
      delete send.runId;
      record.sendsDirty = true;
    }
  }

  /** 配送対象から外して BFF の待機へ戻し、次の実行の開始送信として渡し直す */
  private releaseSteering(record: SessionRecord, entry: QueuedSend): void {
    if (entry.handedOff !== true && entry.steered !== true) return;
    delete entry.handedOff;
    delete entry.steered;
    delete entry.runId;
    const send = record.unsentSends.find((item) => item.sendId === entry.sendId);
    if (send && !record.injectedSends.has(send.sendId)) {
      delete send.runId;
      record.sendsDirty = true;
    }
  }

  /**
   * 追加入力を SDK の steering へ渡す。`"all"` の SDK は受付済みの待機をまとめて渡し、次のモデル
   * 判断の前に全件注入させる。`steer()` は拡張の入力ハンドラを await してから実キューへ積むため、
   * 受付はこの直列チェーンにだけ載せ、各段の直前で運行と待機を再確認する。
   * idle のあいだは `steer()` だけではランが始まらずキューに置き去りになるため、実行中に限り渡す。
   */
  private deliverSteering(record: SessionRecord): void {
    if (record.stopping || record.compacting || record.cancelling > 0) return;
    const run = record.run;
    if (!run || run.status !== "running" || !run.initialInjected) return;
    if (!record.session.steer) return;
    // SDK の idle 判定だけでは終端処理中の窓を取りこぼすため、BFF の実行状態と併せて見る
    if (record.session.isIdle !== false && !record.session.isStreaming) return;
    if (batchesSteering(record)) {
      // `"all"` は先頭が注入されるのを待たず、未配送の待機を先頭からまとめてチェーンへ載せる
      const pending = record.queue.filter((item) => item.handedOff !== true);
      if (pending.length === 0) return;
      for (const entry of pending) entry.handedOff = true;
      this.enqueueSteering(record, run, pending);
      this.emitResync(record);
      return;
    }
    // 一括ドレインを持たない SDK は 1 件ずつ渡す (注入を観測するまで次を渡さない)
    if (this.steeringOf(record) !== undefined) return;
    const entry = record.queue.find((item) => item.handedOff !== true);
    if (!entry) return;
    entry.handedOff = true;
    this.enqueueSteering(record, run, [entry]);
    this.emitResync(record);
  }

  /** steering の受付チェーン 1 組分。解決で `steered`、渡せない分は配送から外す */
  private enqueueSteering(record: SessionRecord, run: RunState, entries: QueuedSend[]): void {
    const steer = record.session.steer?.bind(record.session);
    if (!steer) return;
    const task = (record.steerTask ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        let changed = false;
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          const alive = record.queue.includes(entry) && entry.handedOff === true;
          if (!alive || !this.canDeliverSteering(record, run)) {
            // 取消・終端・停止で渡せなくなった分は配送から外し、後続も打ち切る
            for (const remaining of entries.slice(index)) this.releaseSteering(record, remaining);
            changed = true;
            break;
          }
          let outcome: "queued" | "handled";
          try {
            outcome = await steer(entry.text);
          } catch (error) {
            // 受付できなかった 1 件だけを配送から外し、未送信として残す (自動で入れ直さない)
            this.detachQueued(record, entry);
            record.sendsError = messageFor(error);
            console.warn(`[u7agent] 追加入力をSDKへ渡せませんでした (${record.id}): ${record.sendsError}`);
            changed = true;
            continue;
          }
          if (outcome === "handled") {
            // 実キューに入っていない分は次の実行へ再投入しない (先頭に残して次の注入とずらさない)
            this.detachQueued(record, entry);
            changed = true;
            continue;
          }
          entry.steered = true;
          changed = true;
        }
        if (!changed || this.records.get(record.id) !== record) return;
        this.writeSends(record);
        // 受付ごとではなくチェーン完了後に 1 回だけ配る (N 件の受理で payload を N 回配らない)
        this.emitResync(record);
      })
      .finally(() => {
        if (record.steerTask === task) delete record.steerTask;
      });
    record.steerTask = task;
  }

  /**
   * user メッセージの注入を観測し、送信IDと実行IDを対応付ける。SDK は実キューから取り出した順に
   * user を渡すため、開始送信の次に届く user は控えている `handedOff` の先頭で、本文一致に依存せず
   * 対応が取れる。取り出しの印は実キュー件数から導出するため、ここでは立てない。
   * ディスク保存を待たず resync を配り、次の assistant の delta より先に新しい user を見せる。
   */
  private noteUserInjected(record: SessionRecord, run: RunState, message: object): void {
    if (!run.initialInjected) {
      run.initialInjected = true;
      record.userMessageSends.set(message, { sendId: run.initialSendId, runId: run.id });
      record.injectedSends.add(run.initialSendId);
      this.assignSendRun(record, run.initialSendId, run.id);
    } else {
      const steering = this.steeringOf(record);
      // 対応の取れない user (拡張など) に送信IDを捏造しない
      if (steering === undefined) return;
      record.userMessageSends.set(message, { sendId: steering.sendId, runId: run.id });
      record.injectedSends.add(steering.sendId);
      this.assignSendRun(record, steering.sendId, run.id);
      delete steering.handedOff;
      delete steering.steered;
      const position = record.queue.indexOf(steering);
      if (position !== -1) record.queue.splice(position, 1);
      record.sendsDirty = true;
      this.writeSends(record);
    }
    queueMicrotask(() => {
      if (this.records.get(record.id) !== record) return;
      this.emitResync(record);
    });
    // 注入中に届いた待機は、改めて次の判断へ渡す
    this.deliverSteering(record);
  }

  /**
   * 終端で未注入の steering を回収する。遅い受付や取消が終端後に SDK の実キューへ残らないよう、
   * 受付チェーンと取消チェーンの完了を待ってから実キューを見る。
   */
  private async recoverSteeringAtFinish(record: SessionRecord): Promise<void> {
    await record.steerTask?.catch(() => {});
    if (record.cancelTask !== undefined) await record.cancelTask.catch(() => {});
    if (batchesSteering(record)) {
      const handed = record.queue.filter((item) => item.handedOff === true);
      if (handed.length === 0) return;
      // taken は clearQueue の前に確定する (後に評価すると全件 taken になる)
      const taken = takenSendIdsOf(record);
      if (sdkQueueLength(record) > 0) record.session.clearQueue?.();
      for (const entry of handed) {
        if (taken.has(entry.sendId)) {
          // ドレイン済みで注入されなかった分は配送対象から外して未送信に残す (run id は外さない)
          const position = record.queue.indexOf(entry);
          if (position !== -1) record.queue.splice(position, 1);
          delete entry.handedOff;
          delete entry.steered;
        } else {
          // 実キューに残っていた分は BFF の配送へ戻し、次の実行の開始送信にする
          this.releaseSteering(record, entry);
        }
      }
      this.writeSends(record);
      this.emitResync(record);
      return;
    }
    const entry = this.steeringOf(record);
    if (!entry) return;
    if (sdkQueueLength(record) > 0) {
      record.session.clearQueue?.();
      this.releaseSteering(record, entry);
    } else {
      // 取り出された入力はドレイン済みなので、配送対象から外して未送信に残す
      const position = record.queue.indexOf(entry);
      if (position !== -1) record.queue.splice(position, 1);
      delete entry.handedOff;
      delete entry.steered;
    }
    this.writeSends(record);
    this.emitResync(record);
  }

  /** 受理した送信を「未送信」として控える (同じ送信IDの再送では重ねない) */
  private rememberUnsent(record: SessionRecord, sendId: string, text: string, runId?: string): void {
    // 永続化なしは再起動を跨がないため記録を持たない (未開始のキュー破棄は queue_cleared の
    // sendIds がクライアントへ直接伝える)
    if (!record.writer || !this.storeDir) return;
    if (record.unsentSends.some((item) => item.sendId === sendId)) return;
    record.unsentSends.push({ sendId, ...(runId === undefined ? {} : { runId }), text, at: Date.now() });
    record.sendsDirty = true;
    this.writeSends(record);
  }

  /**
   * 渡された entry スナップショットのうち、JSONL へ書けた user entry の送信対応を控え、保存済みに
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
      const send = record.userMessageSends.get(message);
      if (send === undefined) continue;
      const known = record.entrySends.get(entry.id);
      if (known?.sendId === send.sendId && known.runId === send.runId) continue;
      record.entrySends.set(entry.id, send);
      const index = record.unsentSends.findIndex((item) => item.sendId === send.sendId);
      if (index !== -1) record.unsentSends.splice(index, 1);
      record.injectedSends.delete(send.sendId);
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
   * user message entry へ送信IDと実行IDを写す。entry と送信の対応を JSONL 自身に持たせ、
   * 別ファイル (sends.json) の書込みだけ失敗しても再起動後に対応を失わない。SDK は未知の
   * フィールドをそのまま保持するため、SDK 形式は壊れない。
   */
  private annotateSendIds(record: SessionRecord, entries: SessionEntryLike[]): SessionEntryLike[] {
    return entries.map((entry) => {
      if (entry.type !== "message" || typeof entry.id !== "string" || entry.id === "") return entry;
      const message = entry.message as { role?: unknown } | undefined;
      if (message?.role === "assistant") {
        const assistantId = record.assistantMessageIds.get(message);
        if (assistantId === undefined || entry[ASSISTANT_ID_FIELD] === assistantId) return entry;
        return { ...entry, [ASSISTANT_ID_FIELD]: assistantId };
      }
      if (!message || message.role !== "user") return entry;
      const send = record.userMessageSends.get(message) ?? record.entrySends.get(entry.id);
      if (send === undefined) return entry;
      if (entry[SEND_ID_FIELD] === send.sendId && entry[RUN_ID_FIELD] === send.runId) return entry;
      return {
        ...entry,
        [SEND_ID_FIELD]: send.sendId,
        ...(send.runId === undefined ? {} : { [RUN_ID_FIELD]: send.runId }),
      };
    });
  }

  /**
   * 実行中のランを中断し、未配信の入力を未送信として回収する。新規の送信は先に止め、SDK の受付処理
   * (steer) と取消の完了を待ってから実キューを捨て、abort の完了後に積み残しを再確認する。停止後は
   * 自動配送しない (回収した入力は手動の再送 / 破棄に任せる)。
   */
  async stop(record: SessionRecord): Promise<{ ok: true; status: RunStatus }> {
    record.lastUsedAt = Date.now();
    record.stopping = true;
    try {
      // 受付処理中の steering と取消を取りこぼさない (この完了後にもう一度実キューを見る)。
      // 取消が無い通常の停止で余分な待ちを挟まないよう、進行中の取消があるときだけ待つ
      await record.steerTask?.catch(() => {});
      if (record.cancelTask !== undefined) await record.cancelTask.catch(() => {});
      record.session.clearQueue?.();
      const cleared = this.collectQueued(record);
      if (cleared.length > 0) {
        // 破棄した送信は「未送信」として見せる (実行されないまま黙って消さない)
        this.emit(record, "queue_cleared", { sendIds: cleared.map((item) => item.sendId) });
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
      // abort の完了までに積まれた分を回収する (回収し忘れた入力を次回の実行へ残さない)
      record.session.clearQueue?.();
      const stragglers = this.collectQueued(record);
      if (stragglers.length > 0) this.emit(record, "queue_cleared", { sendIds: stragglers.map((item) => item.sendId) });
      // 未注入の控えは旧実行への割当を外し、未送信として保存する
      let released = false;
      for (const send of record.unsentSends) {
        if (record.injectedSends.has(send.sendId) || send.runId === undefined) continue;
        delete send.runId;
        released = true;
      }
      if (released) record.sendsDirty = true;
      this.writeSends(record);
      // 回収で待機や未送信の割当が変わったときだけ、購読者の表示を揃える
      if (cleared.length + stragglers.length > 0 || released) this.emitResync(record);
      return { ok: true, status: this.statusOf(record) };
    } finally {
      record.stopping = false;
    }
  }

  /** 配送キューを取り出し、未注入の控えから実行への割当を外す (停止・回収で共通) */
  private collectQueued(record: SessionRecord): QueuedSend[] {
    const cleared = record.queue.splice(0, record.queue.length);
    for (const entry of cleared) {
      delete entry.handedOff;
      delete entry.steered;
      const send = record.unsentSends.find((item) => item.sendId === entry.sendId);
      if (send && !record.injectedSends.has(send.sendId)) delete send.runId;
    }
    if (cleared.length > 0) {
      record.sendsDirty = true;
      this.writeSends(record);
    }
    return cleared;
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
   * investigate ツールの実体。親 (cwd と現在のモデル) をここで解決して runner へ渡す。
   * 子の掃除は親 run の signal に寄せるため、専用のフックは持たない。
   */
  investigateHost(): InvestigateHost {
    return {
      investigate: (request) => {
        const record = this.records.get(request.sessionId);
        if (!record) return Promise.reject(new Error(`Session not found: ${request.sessionId}`));
        return this.investigator.investigate({
          sessionId: record.id,
          cwd: record.workdir,
          // 親のツール許可リスト。子はこれを読み取り専用の集合との積で使う
          ...(record.agent.toolNames === undefined ? {} : { toolNames: [...record.agent.toolNames] }),
          ...(record.session.model
            ? { model: { provider: record.session.model.provider, id: record.session.model.id } }
            : {}),
          prompt: request.prompt,
          signal: request.signal,
          ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        });
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
        createdAt: Date.now(),
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
      // 未 settle の待機が 0 -> 1 になる瞬間だけ通知する (settle 済みの tombstone は数えない)
      const opensWaiting = ![...record.questions.values()].some((other) => !other.settled);
      record.questions.set(toolCallId, pending);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (opensWaiting) this.notifyQuestion(record, questions);
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
        const startedAt = record.compactionStartedAt;
        const compactions = recordCompactionOutcome({
          session,
          compactionMeta: record.compactionMeta,
          masker: this.masker,
          cwd: workspaceAbs(this.rootCwd, record.workdir),
          event,
          ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
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
    return compactionsOf(record, this.masker, workspaceAbs(this.rootCwd, record.workdir));
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
    // settle 済みの entry は同じ toolCallId への 2 回目を 409 にする tombstone として残る
    const awaiting = [...record.questions.values()].filter((pending) => !pending.settled);
    return projectSessionSummary({
      record,
      status: this.statusOf(record),
      awaitingAnswer: awaiting.length > 0,
      awaitingSince: awaiting.reduce<number | undefined>(
        (oldest, pending) => (oldest === undefined ? pending.createdAt : Math.min(oldest, pending.createdAt)),
        undefined,
      ),
      lastRunDurationMs: record.run ? record.runOutcomes.get(record.run.id)?.durationMs : undefined,
      projectId: this.projectIdOf(record),
      masker: this.masker,
      cwd: workspaceAbs(this.rootCwd, record.workdir),
      hasRawLog: this.hasRawLogOf(record.id, record.storeDir),
    });
  }

  /** 生ログ (session.jsonl) がディスクにあるか。一覧の「生ログをダウンロード」の出し分けに使う */
  private hasRawLogOf(id: string, storeDir: string): boolean {
    return storeDir !== "" && existsSync(sessionJsonlPath(id, storeDir));
  }

  /**
   * 生ログ (`session.jsonl`) の実体。**SDK を開かない** (壊れた JSONL でも取れることを優先する)。
   * 未永続化・履歴の破棄後は `missing`、会話自体が無い id は `unknown` で、経路はどちらも 404 にする。
   * サイズは既存のセッションファイルと同じく上限を設けず、読む側 (HTTP) がストリームで返す。
   */
  async rawLogOfId(
    id: string,
  ): Promise<{ state: "unknown" } | { state: "missing" } | { state: "ok"; path: string; bytes: number }> {
    if (!this.records.has(id) && !this.descriptors.has(id)) return { state: "unknown" };
    if (!this.storeDir) return { state: "missing" };
    const path = sessionJsonlPath(id, this.storeDir);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return { state: "missing" };
    return { state: "ok", path, bytes: info.size };
  }

  /**
   * 不具合の切り分け用のダンプ。live な record は全項目を、未ロードの会話は保存済み meta だけを返す
   * (SDK の復元で状態を変えない。壊れた JSONL でもメタは取れる)。未知の id は undefined。
   */
  async diagnosticsOf(id: string): Promise<SessionDiagnostics | undefined> {
    const raw = await this.rawLogOfId(id);
    const rawInfo = { available: raw.state === "ok", ...(raw.state === "ok" ? { bytes: raw.bytes } : {}) };
    const record = this.records.get(id);
    if (record) {
      return projectSessionDiagnostics({
        masker: this.masker,
        input: {
          sessionId: record.id,
          generation: record.generation,
          seq: record.seq,
          events: record.events,
          status: this.statusOf(record),
          queueSendIds: record.queue.map((item) => item.sendId),
          run: record.run
            ? {
                id: record.run.id,
                status: record.run.status,
                startedAt: record.run.startedAt,
                ...(record.run.endedAt !== undefined ? { endedAt: record.run.endedAt } : {}),
                totalRetryCount: record.run.totalRetryCount,
                ...(record.run.retry ? { retry: record.run.retry } : {}),
                ...(record.run.errorCode ? { errorCode: record.run.errorCode } : {}),
                ...(record.run.error ? { error: record.run.error } : {}),
              }
            : null,
          questions: [...record.questions].map(([toolCallId, pending]) => ({
            toolCallId,
            questionCount: pending.questions.length,
            settled: pending.settled,
          })),
          meta: {
            spaceId: record.meta.spaceId ?? "default",
            agentId: record.agentId,
            agentName: record.agent.name,
            ...(record.projectId ? { projectId: record.projectId } : {}),
            ...(record.projectName ? { projectName: record.projectName } : {}),
            workdir: record.workdir,
            createdAt: record.createdAt,
            lastUsedAt: record.lastUsedAt,
            messageCount: record.meta.messageCount,
            ...(modelLabel(record.session.model) ? { model: modelLabel(record.session.model) } : {}),
            ...(record.session.thinkingLevel ? { thinkingLevel: record.session.thinkingLevel } : {}),
            notify: record.notify,
            pinned: record.pinned,
            ...(record.persistError ? { persistError: record.persistError } : {}),
            ...(record.sendsError ? { sendsError: record.sendsError } : {}),
            sendsDirty: record.sendsDirty,
          },
          raw: rawInfo,
        },
      });
    }
    const meta = this.descriptors.get(id);
    if (!meta) return undefined;
    return projectSessionDiagnostics({
      masker: this.masker,
      input: {
        sessionId: meta.id,
        generation: "",
        seq: 0,
        events: [],
        status: "idle",
        queueSendIds: [],
        run: null,
        questions: [],
        meta: {
          spaceId: meta.spaceId ?? "default",
          agentId: meta.agentId,
          agentName: meta.agent.name,
          ...(this.projectIdOfCwd(meta.projectCwd) ? { projectId: this.projectIdOfCwd(meta.projectCwd) } : {}),
          ...(meta.projectName ? { projectName: meta.projectName } : {}),
          workdir: this.workdirOf(meta.id, meta.projectCwd, meta.spaceId),
          createdAt: meta.createdAt,
          lastUsedAt: meta.lastUsedAt,
          messageCount: meta.messageCount,
          ...(meta.model ? { model: meta.model } : {}),
          ...(meta.thinkingLevel ? { thinkingLevel: meta.thinkingLevel } : {}),
          notify: meta.notify === true,
          pinned: meta.pinned === true,
          sendsDirty: false,
        },
        raw: rawInfo,
      },
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
      canHandoff: true,
      projectSession: meta.projectCwd !== undefined,
      ...(meta.handoffCleanup ? { handoffCleanup: true } : {}),
      hasRawLog: this.hasRawLogOf(meta.id, this.storeDir ?? ""),
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

  /** SessionPayload.cwd は rootCwd 相対。所属があれば登録ディレクトリ、未所属は所属スペースのスクラッチ (root は永続化なしの既定スペースだけ) */
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

  /**
   * セッションを削除する。SDK を開かずに消せる (モデル未認証・JSONL 破損でも可)。作業フォルダは残す。
   * `expectSpaceId` は削除の直前の所属で、`move` などの待機の後で再確認する (引っ越し中の会話を
   * 移動元スペースの削除が巻き込まないため)。不一致なら削除せず false を返す。
   */
  async deleteSession(id: string, { expectSpaceId }: { expectSpaceId?: string } = {}): Promise<boolean> {
    if (!this.records.has(id) && !this.descriptors.has(id)) return false;
    this.deleting.add(id);
    try {
      const pending = this.lifecycle.get(id);
      if (pending) await pending.catch(() => {});
      const pendingMeta = this.metaUpdates.get(id);
      if (pendingMeta) await pendingMeta.catch(() => {});
      const pendingPin = this.pinUpdates.get(id);
      if (pendingPin) await pendingPin.catch(() => {});
      if (expectSpaceId !== undefined) {
        const meta = this.records.get(id)?.meta ?? this.descriptors.get(id);
        if (meta && (meta.spaceId ?? "default") !== expectSpaceId) return false;
      }
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

  /**
   * 会話を引き継ぐ (引っ越しの拡張)。会話の行・タイトル・ピン・通知・作成時刻は保ち、履歴だけを新しくする。
   * 同一スペースでも引き継げ、別スペースなら作業フォルダ / 添付 / cwd キーの行を移動先へ移す。メモ
   * (HANDOFF.md) は確定より前に書き、確定後の履歴削除が失敗したときだけ success のまま `cleanupPending` を返す。
   */
  async move(
    id: string,
    targetSpaceId: string,
    options: { agentId?: string; memo?: boolean } = {},
  ): Promise<SessionMoveResponse | undefined> {
    // 削除側が引く引っ越し先は検証済みの値にする (moveSession と同じ正規化をここでも行う)
    const target = spaceIdOf(targetSpaceId);
    const operation = (async () => {
      // 先行の load / meta 更新 / ピン更新を待つ (record を差し替える前に descriptor を確定させる)
      for (const pending of [this.lifecycle.get(id), this.metaUpdates.get(id), this.pinUpdates.get(id)]) {
        if (pending) await pending.catch(() => {});
      }
      return this.moveSession(id, targetSpaceId, options);
    })();
    const settled = operation.then(
      () => {},
      () => {},
    );
    // resolve / deleteSession / sweep を move の完了まで待たせる (setPinned と同じ lifecycle に乗せる)
    this.lifecycle.set(id, settled);
    // 削除の claim はこれから届く要求しか止めないため、受理済みの引っ越しを対象スペースの削除が引けるようにする
    // (同じ会話に重なっても先行を隠さないよう、会話 ID ではなく操作単位で持つ)
    const pending: PendingMove = { spaceId: target, settled };
    this.pendingMoves.add(pending);
    try {
      return await operation;
    } finally {
      // 自分の登録だけを外す (同じ会話の後続の登録を消さない)
      this.pendingMoves.delete(pending);
      if (this.lifecycle.get(id) === settled) this.lifecycle.delete(id);
    }
  }

  /**
   * 対象スペースへ向かう受理済みの引っ越しが終わる (完了 / ロールバック) まで待つ。claim だけでは
   * 止まらないため、作業フォルダを運んだまま対象の根を消すと、移動元の会話のファイルも失う。
   * 同じ会話に複数が重なっていても操作単位で待つ。戻り値は待った件数。
   */
  async waitForMovesInto(spaceId: string): Promise<number> {
    const pending = [...this.pendingMoves].filter((move) => move.spaceId === spaceId).map((move) => move.settled);
    await Promise.all(pending);
    return pending.length;
  }

  private async moveSession(
    id: string,
    targetSpaceId: string,
    options: { agentId?: string; memo?: boolean },
  ): Promise<SessionMoveResponse | undefined> {
    const target = spaceIdOf(targetSpaceId);
    const memo = options.memo === true;
    if (this.storeError) throw httpError(503, `会話ストアを利用できません: ${this.storeError}`);
    if (!this.storeDir) throw httpError(503, "セッションの移動には会話ストアが必要です");
    if (!this.moveSandbox || !this.workspace || !this.handoffSandbox) {
      throw httpError(503, SANDBOX_NOT_CONFIGURED_MESSAGE);
    }
    const live = this.records.get(id);
    const meta = live?.meta ?? this.descriptors.get(id);
    if (!meta) return undefined;
    const fromSpace = meta.spaceId ?? "default";
    const moving = fromSpace !== target;
    if (meta.handoffCleanup) throw httpError(409, HANDOFF_CLEANUP_PENDING_MESSAGE);
    // プロジェクト所属は作業ディレクトリが同じで移す先がないため、同じスペースへの引き継ぎだけを許す
    if (meta.projectCwd && moving) {
      throw httpError(400, "プロジェクト所属のセッションは同じ会話スペースへだけ引き継げます");
    }
    // スクラッチ以外 (projectCwd の残骸など) を動かさないための不変条件
    const fromWorkdir = live?.workdir ?? this.workdirOf(id, meta.projectCwd, fromSpace);
    if (!meta.projectCwd && fromWorkdir !== sessionWorkdirRel(id, fromSpace)) {
      throw httpError(400, "移動できるのはセッション専用の作業フォルダだけです");
    }
    if (live && (this.isBusy(live) || live.session.isStreaming || live.changingSettings)) {
      throw httpError(409, "実行中・キュー中・設定変更中のセッションは引き継げません");
    }

    const storeDir = this.storeDir;
    const moveSandbox = this.moveSandbox;
    const workspace = this.workspace;
    const handoffSandbox = this.handoffSandbox;
    const toWorkdir = meta.projectCwd ?? sessionWorkdirRel(id, target);
    const fromUploads = sessionUploadsRel(id, fromSpace);
    const toUploads = sessionUploadsRel(id, target);
    // 古い値の保存が移動後の meta を上書きしないよう、先に drain する
    if (live) await this.drainRecordWrites(live);
    // drain 中の setNotify / setTitle / setPinned を落とさないよう、最新の meta から組み立てる
    const current = live?.meta ?? this.descriptors.get(id) ?? meta;
    if (current.handoffCleanup) throw httpError(409, HANDOFF_CLEANUP_PENDING_MESSAGE);

    // 引き継ぎ先のエージェント。「指定なし」は保存済みのスナップショットを維持する (現在のエージェントが
    // カタログから消えていても引き継げる)。「指定あり」は現在と同じ id でも新規作成と同じ経路で解決し直し、
    // 定義の更新を反映し、未知・削除済みの id は 400 にする (UI の「現在」は id を省略する)
    const resolved = options.agentId === undefined ? undefined : resolveAgentSkills(this.catalog, options.agentId);
    const agentId = resolved?.agentInfo.id ?? current.agentId;
    const agentInfo = resolved?.agentInfo ?? current.agent;
    const promptSnapshot = resolved?.promptSnapshot ?? current.promptSnapshot;

    const operationId = generateHandoffOperationId();
    const at = Date.now();

    // メモの下準備 (副作用なし)。材料と既存の HANDOFF.md をここで読み、会話の状態を変える前に拒否する。
    // 追記後の全文を組み立てるのはここでの上限判定のためで、書込みは排他の中で再読取りして再適用する
    let memoSection: HandoffMemoSection | undefined;
    let memoExisting = "";
    const memoPath = posix.join(toWorkdir, HANDOFF_FILE_NAME);
    if (memo) {
      const { parsed } = await readSessionFile(storeDir, id);
      if (parsed.kind === "damaged") {
        throw httpError(
          400,
          `保存された会話を読めないためメモを作れません (${parsed.reason})。「メモを作る」を外すと引き継げます`,
        );
      }
      const section = buildHandoffSection({
        entries: parsed.kind === "ok" ? parsed.entries : [],
        title: current.title,
        fromAgent: current.agent.name,
        toAgent: agentInfo.name,
        operationId,
        at,
        masker: this.masker,
      });
      if (!section) throw httpError(400, "メモにできる会話がまだありません。「メモを作る」を外すと引き継げます");
      const readPath = moving ? posix.join(fromWorkdir, HANDOFF_FILE_NAME) : memoPath;
      try {
        memoExisting = (await handoffSandbox.readHandoff(readPath)).text;
      } catch (error) {
        if (error instanceof SandboxRequestError && error.status === 404) {
          memoExisting = "";
        } else {
          throw httpError(
            400,
            `作業フォルダの HANDOFF.md を読めないためメモを作れません (${messageFor(error)})。「メモを作る」を外すと引き継げます`,
          );
        }
      }
      const total =
        Buffer.byteLength(memoExisting, "utf8") +
        // 先頭見出しのハッシュが既にあるときは追記されないので、追記分を足さずに評価する
        // (確定前の失敗からの再試行で、全文がちょうど上限でも通す)
        (memoExisting.split("\n", 1)[0]?.includes(section.hash) ? 0 : Buffer.byteLength(section.text, "utf8"));
      if (total > SANDBOX_MAX_HANDOFF_BYTES) {
        throw httpError(
          400,
          "HANDOFF.md が上限 (2 MiB) を超えるためメモを作れません。「メモを作る」を外すと引き継げます",
        );
      }
      memoSection = section;
    }

    // meta 書換えより前の失敗だけを戻す。移動先に残った空ディレクトリは無害なので消さない
    const undo: Array<() => Promise<void> | void> = [];
    const rollback = async (): Promise<string | undefined> => {
      let failure: string | undefined;
      for (const step of [...undo].reverse()) {
        try {
          await step();
        } catch (error) {
          failure = failure ?? messageFor(error);
        }
      }
      return failure;
    };
    const abortMove = async (): Promise<undefined> => {
      const failure = await rollback();
      if (failure) throw httpError(500, `移動を中止し、元の場所へ戻せませんでした: ${failure}`);
      return undefined;
    };
    const failMove = async (error: unknown): Promise<never> => {
      const failure = await rollback();
      if (failure) throw httpError(500, `移動に失敗し、元の場所へ戻せませんでした: ${failure}`);
      throw error instanceof SandboxRequestError ? httpError(sandboxFailureStatus(error), error.message) : error;
    };

    const updated: SessionMeta = {
      ...current,
      spaceId: target,
      lastUsedAt: at,
      messageCount: 0,
      agentId,
      agent: agentInfo,
      promptSnapshot,
      handoff: { operationId, at, memo: memoSection !== undefined, consumed: false } satisfies SessionHandoffRecord,
      handoffCleanup: true,
    };
    try {
      if (moving) {
        // 移動先の親は move が要求する (既存ディレクトリは成功扱いなので再実行でも冪等)
        await workspace.createDir(dirname(toWorkdir));
        await workspace.createDir(dirname(toUploads));
        if (this.moveAborted(id)) return abortMove();

        if (await this.moveSandboxEntry(moveSandbox, fromWorkdir, toWorkdir)) {
          undo.push(async () => {
            await moveSandbox.moveEntry(toWorkdir, fromWorkdir);
          });
        }
        if (this.moveAborted(id)) return abortMove();

        if (await this.moveSandboxEntry(moveSandbox, fromUploads, toUploads)) {
          undo.push(async () => {
            await moveSandbox.moveEntry(toUploads, fromUploads);
          });
        }
        if (this.moveAborted(id)) return abortMove();

        // cwd をキーにする行は移動先へ付け替える (値の AAD は cwd を含まないので再暗号化は不要)
        try {
          this.cwdKeys?.moveCwd(fromWorkdir, toWorkdir);
        } catch (error) {
          throw httpError(500, `環境変数とサービス実績の付け替えに失敗しました: ${messageFor(error)}`);
        }
        undo.push(() => this.cwdKeys?.moveCwd(toWorkdir, fromWorkdir));
      }

      // メモは確定より前に書く (確定した時点でメモの状態が最終になる)。失敗したらここまでの移動を戻す
      if (memoSection) {
        const written = await handoffSandbox.writeHandoff({
          path: memoPath,
          section: memoSection.text,
          dedupeKey: memoSection.hash,
        });
        if (written.created) {
          // 新規作成の rollback は、自分が書いた内容と一致するときだけ消す。既存への追記は戻さない
          const expected = `${memoSection.text}${memoExisting}`;
          undo.push(async () => {
            await handoffSandbox.rollbackHandoff({ path: memoPath, expected });
          });
        }
      }
      if (this.moveAborted(id)) return abortMove();

      await writeSessionMeta(storeDir, updated);
      this.descriptors.set(id, updated);
      if (live) live.meta = updated;
    } catch (error) {
      return failMove(error);
    }

    // ここから先は meta が確定済み。失敗しても戻さず、片付けの印を残して次回の保存 / 開くときに再試行する
    let cleanupPending = false;
    if (live) {
      live.session.dispose?.();
      this.records.delete(id);
      // dispose 後の書込みを drain してから消す (削除後に書き戻されて未送信が復活しないように)
      await this.drainRecordWrites(live);
    }
    try {
      await removeSessionHistory(storeDir, id);
    } catch {
      cleanupPending = true;
    }
    if (!cleanupPending) {
      const cleared: SessionMeta = { ...updated };
      delete cleared.handoffCleanup;
      try {
        await writeSessionMeta(storeDir, cleared);
        this.descriptors.set(id, cleared);
        if (live) live.meta = cleared;
      } catch {
        // 確定は済んでいる。印が残るだけなので次の保存で再試行する
        cleanupPending = true;
      }
    }
    if (live) {
      // 確定後の失敗は、応答だけでなく購読中のタブへ resync でも伝える (開けない理由を先に出す)
      if (cleanupPending) this.emitResync(live);
      this.closeSubscribers(live);
    }
    return {
      sessionId: id,
      title: updated.title || "無題のセッション",
      spaceId: target,
      memo: memoSection !== undefined,
      cleanupPending,
    };
  }

  /** 削除予約 / close を検出する。move は各 await の後でこれを見てロールバックする */
  private moveAborted(id: string): boolean {
    return this.deleting.has(id) || this.closing;
  }

  /**
   * 作業フォルダ / 添付を 1 つ移す。元が無い (404) は「運ぶものが無い」として false を返し、
   * 移動先が既にある (409) はマージできないため、手動での退避先の削除を案内する。
   */
  private async moveSandboxEntry(client: SandboxMoveClient, from: string, to: string): Promise<boolean> {
    try {
      await client.moveEntry(from, to);
      return true;
    } catch (error) {
      if (!(error instanceof SandboxRequestError)) throw error;
      if (error.status === 404) return false;
      if (error.status === 409) {
        throw httpError(
          409,
          `移動先に既存のエントリがあります。退避先を削除してから再実行してください: ${error.message}`,
        );
      }
      throw error;
    }
  }

  /** 進行中の保存を待つ (移動で meta を書き換える前に古い値の書込みを終わらせる) */
  private async drainRecordWrites(record: SessionRecord): Promise<void> {
    await record.persistTail.catch(() => {});
    await record.writer?.flush().catch(() => {});
  }

  /** 購読中の SSE を閉じる (移動は削除ではないためイベントは送らない。クライアントは一覧を取り直す) */
  private closeSubscribers(record: SessionRecord): void {
    const subscribers = [...record.subscribers];
    record.subscribers.clear();
    for (const subscriber of subscribers) {
      try {
        subscriber.close?.();
      } catch {
        // すでに切断済みの購読者
      }
    }
  }

  private notifyDeleted(record: SessionRecord): void {
    const subscribers = [...record.subscribers];
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
    }
    this.closeSubscribers(record);
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
        messageCount: displayableMessages(session, this.masker, workspaceAbs(this.rootCwd, record.workdir)).length,
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
      const entries = this.annotateSendIds(record, entriesOf(session));
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
        if (this.deleting.has(id) || this.lifecycle.has(id) || this.metaUpdates.has(id) || this.pinUpdates.has(id))
          continue;
        if (record.lastUsedAt >= cutoff) continue;
        // 終了直後は実行状況の行として残す (この間だけは lastUsedAt が古くても sweep しない)
        if (record.run?.endedAt !== undefined && Date.now() - record.run.endedAt <= FINISHED_RETENTION_MS) continue;
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
    await Promise.allSettled(Array.from(this.metaUpdates.values()));
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
  startRun(record: SessionRecord, text: string, sendId: string, runId?: string): RunState {
    const { session } = record;
    const run: RunState = {
      id: runId ?? randomBytes(8).toString("hex"),
      initialSendId: sendId,
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
    // 実行を開始した送信を控える (所要時間と結末はこの送信の item にだけ写す)
    record.runInitialSends.set(run.id, sendId);
    this.assignSendRun(record, sendId, run.id);
    record.tools = new Map();
    // 質問の待機も run と同じ寿命。前の run の tombstone (回答済み) を次の run へ持ち越さない
    record.questions = new Map();
    record.lastUsedAt = Date.now();
    this.emit(record, "run_start", {
      runId: run.id,
      initialSendId: run.initialSendId,
      prompt: run.prompt,
      startedAt: run.startedAt,
    });

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
      // ラン全体の所要時間と結末を run id で控える (履歴の user item とライブのバブルがここを正にする)。
      // 非終端の値を控えに残さないよう、終端の 3 値へ narrow してから入れる
      const outcome = RunOutcomeSchema.safeParse(run.status);
      const durationMs = runDurationMs({ startedAt: run.startedAt, endedAt, tools: record.tools.values() });
      if (outcome.success) {
        record.runOutcomes.set(run.id, { durationMs, outcome: outcome.data });
      }
      // アクティブな再試行は終了で消す。累計は結果表示のため残す
      delete run.retry;
      if (error) run.error = this.masker.mask(composeRunError(error, run.totalRetryCount));
      // 分類コードは最終失敗のときだけ公開する。停止要求と例外が同時なら status は stopped で、
      // クライアントに再実行カードを出させない (run.error は従来どおり残す)
      if (run.status === "error" && error) run.errorCode = error.code;
      // 一覧 API / meta と同じ表示メッセージ数。ここを履歴の生件数 (session.messages.length) へ
      // 戻すと同名フィールドの定義が 2 つに戻る
      const messages = displayableMessages(session, this.masker, workspaceAbs(this.rootCwd, record.workdir));
      this.emit(record, "run_end", {
        runId: run.id,
        status: run.status,
        // 完了の合計時間。キュー待ちと回答待ち (ask_user の実行区間) は含めず、実際に走ったぶんだけを測る
        durationMs,
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
      void this.persist(record).then((failure) => {
        // 保存が済んだ / 失敗した注入済みの送信は、実行中ではなく未送信として扱う
        record.injectedSends.clear();
        if (this.records.get(record.id) !== record) return;
        // この実行の送信が保存されていない (認証エラー等で user entry を残さなかった) ときだけ、
        // 未送信の表示を購読者へ揃える。別の実行の待機は `queued` が既に配っている
        if (failure || record.unsentSends.some((item) => item.sendId === run.initialSendId || item.runId === run.id)) {
          this.emitResync(record);
        }
      });

      // 送信は fire-and-forget。run_end の記録・persist・キューの pump を待たせない
      this.notifyCompleted(record, run, bridge.settledAssistantText(), durationMs);

      // 受付処理中の steering が終端後に実キューへ残らないよう、回収を待ってから次を開始する
      void this.recoverSteeringAtFinish(record)
        .catch(() => {})
        .finally(() => {
          if (this.records.get(record.id) !== record) return;
          if (record.stopping || record.queue.length === 0) return;
          setTimeout(() => this.pump(record), QUEUE_DELAY_MS).unref?.();
        });
    };

    const bridge = createRunEventBridge({
      session,
      runId: run.id,
      masker: this.masker,
      // 履歴側と同じ絶対 cwd。root 相対と絶対を混ぜると解決結果が経路でずれる
      cwd: workspaceAbs(this.rootCwd, record.workdir),
      tools: record.tools,
      toolTimings: record.toolTimings,
      messageMetrics: record.messageMetrics,
      compactionMeta: record.compactionMeta,
      emit: (type, data) => this.emit(record, type, data),
      // 遅延した resync (context_edit の microtask) が次のランへ漏れないよう、ラン ID を確認してから配る
      emitResync: (reason) => {
        if (record.run === run && run.status === "running") this.emitResync(record, reason);
      },
      // SDK は listener 通知の後に entry を append する。1 拍置いてから読む (保存点の順序テストあり)
      onPersist: () => queueMicrotask(() => void this.persist(record)),
      onAssistantMessage: (message, assistantId) => {
        record.assistantMessageIds.set(message, assistantId);
      },
      // 履歴 item に送信ID / 実行ID を写すための控え。SDK は listener の後に entry を append するが、
      // entry と session.messages は同じメッセージ参照を共有するので、投影時に参照で引ける
      onPromptMessage: (message) => this.noteUserInjected(record, run, message),
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
  private notifyCompleted(record: SessionRecord, run: RunState, body: string | undefined, durationMs: number): void {
    if (!this.notifications || run.status !== "completed" || !record.notify) return;
    if (!body?.trim()) return;
    this.notifications.notifySession({
      sessionId: record.id,
      spaceId: record.meta.spaceId,
      title: record.title,
      agentName: record.agent.name,
      body,
      durationMs,
      toolCalls: record.tools.size,
    });
  }

  /**
   * 質問通知。未 settle の待機が 0 -> 1 になる瞬間に 1 通だけ送り、登録と回答を待たせない。
   * 本文の有無は会話の通知 (`notify`) で決め、並行する 2 件目の呼び出しでは送らない (集約はしない)。
   */
  private notifyQuestion(record: SessionRecord, questions: AskUserQuestion[]): void {
    if (!this.notifications) return;
    const first = questions[0];
    if (!first) return;
    this.notifications.notifyQuestion({
      sessionId: record.id,
      spaceId: record.meta.spaceId,
      title: record.title,
      agentName: record.agent.name,
      questionCount: questions.length,
      ...(record.notify ? { question: first.question } : {}),
    });
  }

  pump(record: SessionRecord): void {
    // close / 停止中は新しい run を始めない (停止後は手動の再送に任せる)
    if (this.closing || record.stopping || this.deleting.has(record.id) || this.records.get(record.id) !== record) {
      return;
    }
    // 圧縮の終端処理が done してから呼ばれる (圧縮中はキューを進めない)
    if (record.compacting) return;
    if (record.queue.length === 0) return;
    // 受付処理中の steering が終わるとき、SDK の実キューへ同じ入力を残さないよう開始を待つ
    if (record.steerTask !== undefined) return;
    // 取消中は実キューの操作が終わるまで次の実行を始めない (取消した入力を次で開始しない)
    if (record.cancelling > 0) return;
    if (record.queue[0].handedOff === true || record.queue[0].steered === true) return;
    if (this.runInProgress(record)) return;
    const next = record.queue.shift();
    if (next === undefined) return;
    record.lastUsedAt = Date.now();
    this.startRun(record, next.text, next.sendId);
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
