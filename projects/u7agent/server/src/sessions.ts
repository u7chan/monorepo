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
import { spaceIdOf } from "./spaces";
import { sessionUploadsRel, workspaceAbs } from "./app-paths";
import { SANDBOX_SETUP_REQUIRED_MESSAGE, type PiBff } from "./agent";
import { composePromptSnapshot } from "./session-prompt";
import { applyHandoffMove, prepareHandoffMemo, type HandoffMoveFiles, type HandoffMovePort } from "./handoff-move";
import type { AssistantMetricsRow, AssistantMetricsStore, CwdKeyStore } from "./app-db";
import { httpError, messageFor, type HttpError } from "./errors";
import { sandboxFailureStatus } from "./http";
import { allowsNaturalInvocation, type AgentCatalog } from "./agents";
import { createInvestigateRunner, type InvestigateRunner } from "./investigate-runner";
import type { InvestigateHost } from "./investigate-tool";
import { validateAskUserAnswers, type AskUserHost } from "./ask-user-tool";
import { NetworkAccessApprovals, approvalOf, networkAccessMode, type NetworkAccessMode } from "./network-access";
import {
  REQUEST_NETWORK_ACCESS_TOOL_NAME,
  deriveNetworkAccessQuestions,
  networkAccessOutcome,
  normalizeNetworkAccessHost,
  type NetworkAccessHost,
} from "./request-network-access-tool";
import { stripAttachedFiles } from "./attachments";
import { compactionsOf, recordCompactionOutcome } from "./compaction-view";
import { projectSessionDiagnostics } from "./diagnostics";
import { projectHistoryPage } from "./history-projection";
import type { NotificationService } from "./notifications";
import {
  contextUsageOf,
  parseUsage,
  type PiRuntimeLike,
  type PiSessionEvent,
  type PiSessionLike,
  type PiSessionMessageLike,
} from "./pi-runtime";
import type { ProjectStore } from "./projects";
import { createSecretMasker, type SecretMasker } from "./redact";
import { classifyRunError, composeRunError, retryWaitingText } from "./error-classify";
import { computeMessageMetrics, createRunEventBridge, type RunSettlement } from "./run-events";
import { runDurationMs } from "./run-metrics";
import { withoutThinking } from "./live-thinking";
import { KeyedSerialLock } from "./serial-lock";
import type {
  CreateSessionOptions,
  PendingQuestion,
  PendingQuestionKind,
  PostMessageResultInternal,
  QueuedSend,
  RunState,
  SessionRecord,
  SessionSubscriber,
  UpdateSessionSettingsInput,
} from "./session-record";
import { projectSessionPayload, projectSessionSummary } from "./session-payload";
import { batchesSteering, sdkQueueLength, takenSendIdsOf } from "./session-steering";
import { RunOutcomeSchema } from "./schema";
import {
  normalizeTitleText,
  TITLE_MAX,
  TITLE_REQUEST_MAX,
  titleOriginOf,
  titleRequestOf,
  titleSummaryOf,
  settledTitleAttemptOf,
  type SessionTitleSummary,
  type TitleAttempt,
  type TitleOrigin,
} from "./session-title";
import type { TitleSummaryHost } from "./title-summary";
import { TitleSummaryQueue } from "./title-summary-queue";
import { TitleSummaryProgress } from "./title-summary-progress";
import { displayableMessages, truncate } from "./session-projection";
import { formatModelRef, modelLabel, parseModelRef } from "./model-ref";
import { SessionRecordWrites, entriesOf } from "./session-record-writes";
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
  writeSessionDir,
  ASSISTANT_ID_FIELD,
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
  MessageMetrics,
  ModelRef,
  Project,
  ResyncReason,
  RunStatus,
  SessionCompactionResult,
  SessionDiagnostics,
  SessionHistoryClearResponse,
  SessionMoveResponse,
  SessionNotifyResponse,
  SessionPinnedResponse,
  SessionPayload,
  SessionSummary,
  ServeCommand,
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
/** 引き継ぎの片付け (確定後に残った履歴の削除) が済んでいない会話の共通文言 */
const HANDOFF_CLEANUP_PENDING_MESSAGE =
  "前回の引き継ぎの片付けが残っています。会話を開いてから、もう一度お試しください";
/** 会話履歴のクリアで確定した削除 (片付け) が済んでいない会話の共通文言 */
const HISTORY_CLEANUP_PENDING_MESSAGE =
  "前回の会話履歴の片付けが残っています。会話を開いてから、もう一度お試しください";
/** クリアの確認より前に会話の状態が変わったときの共通文言 (クライアントは自動再試行しない) */
const HISTORY_CHANGED_MESSAGE = "会話履歴が別の操作で変わりました。開き直してから、もう一度お試しください";
const NO_UNTITLED_TITLE = "無題のセッション";
/** 分岐した子と作業フォルダ / 添付を共有している会話を、別のスペースへ運べない理由 */
const SHARED_PLACEMENT_MESSAGE =
  "同じ作業フォルダまたは添付を共有している会話があるため、別のスペースへは引き継げません。" +
  "同じスペースへのエージェント交代だけができます";
/** 共有しているフォルダが消えているときの文言。空フォルダを作って「ファイルが消えた」ように見せない */
const SHARED_PLACEMENT_MISSING_MESSAGE =
  "共有している作業フォルダが見つかりません。分岐元の会話を開いて、作業フォルダを確かめてください";

/** SDK の compact() が投げる既知の理由。完全一致で分類する (部分一致は別の失敗を拾い得る) */
const COMPACTION_TOO_SMALL = "Nothing to compact (session too small)";
const COMPACTION_ALREADY = "Already compacted";
const COMPACTION_CANCELLED = "Compaction cancelled";

/** compaction の失敗理由。応答の status と、終端 status イベントの文言を組で持つ */
interface CompactionFailure {
  error: HttpError;
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

/**
 * 会話の作業ディレクトリ (root 相対の cwd) から serve の成功実績を引く狭い lookup。
 * AppDb が構造的に満たす (一覧の応答へ実績を載せるためだけに使う)。
 */
export interface ServeCommandLookup {
  getServeCommand(cwd: string): { cwd: string; command: string } | undefined;
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
  /** serve の成功実績の参照。未指定は一覧の `serveCommand` を常に null にする (テスト) */
  serveCommands?: ServeCommandLookup | null;
  /**
   * 応答メトリクスの保存先。未指定は保存も読み戻しもしない (テスト)。
   * 読み書きは best-effort で、失敗してもランとセッションの操作は止めない
   */
  assistantMetrics?: AssistantMetricsStore | null;
  /** BFF 側のワークスペース root (作業フォルダの絶対パス解決用) */
  rootCwd?: string;
  /** 完了通知の送信先。未指定なら通知しない (テスト・未設定のデプロイ) */
  notifications?: NotificationService | null;
  /**
   * 送信対応記録の書込み。既定は `writeSessionSends` で、書込み失敗の再試行をテストするためだけに
   * 差し替えられる (SessionFileWriter の writeChunk と同じテスト用の差し込み口)
   */
  writeSends?: (storeDir: string, id: string, sends: SessionSends) => void;
  /**
   * 会話タイトルの AI 要約。未指定は要約しない (テスト・ランタイム未設定)。呼ぶかどうかの判断と
   * 試行の記録は会話ストアが持ち、ホストは設定の読み取りと 1 回の生成だけを担う。
   */
  titleSummary?: TitleSummaryHost | null;
  /**
   * AI 要約の共有実行制御。未指定はプロセス内の既定 (同時 1 件・待ち 15 秒) を使う。
   * テストは上限と待ち時間を縮めた実体を渡す。
   */
  titleSummaryQueue?: TitleSummaryQueue | null;
}

/**
 * 応答 1 件分の保存行。metrics を観測できた応答だけを渡す前提で、行にできない応答は undefined を返す。
 * provider / model が無い応答を落とすのは、列が NOT NULL で、どのモデルの速度か言えない行は集計できないため。
 */
function assistantMetricsRowOf(
  sessionId: string,
  assistantId: string,
  message: PiSessionMessageLike,
  metrics: MessageMetrics,
): AssistantMetricsRow | undefined {
  const { provider, model } = message;
  if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") {
    return undefined;
  }
  const usage = parseUsage(message.usage);
  return {
    sessionId,
    assistantId,
    // timestamp を持たない履歴でも行を落とさない: at は期間で絞る集計の索引として使う
    at: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
    provider,
    model,
    durationMs: metrics.durationMs,
    ttftMs: metrics.ttftMs ?? null,
    inputTokens: usage?.input ?? null,
    outputTokens: usage?.output ?? null,
    cacheRead: usage?.cacheRead ?? null,
    cacheWrite: usage?.cacheWrite ?? null,
    reasoningTokens: usage?.reasoning ?? null,
    costUsd: usage?.cost.total ?? null,
    stopReason: typeof message.stopReason === "string" && message.stopReason !== "" ? message.stopReason : null,
  };
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

/** 会話の末尾 entry の id (分岐の境界)。entry が無ければ undefined */
function lastEntryId(entries: SessionEntryLike[]): string | undefined {
  const last = entries[entries.length - 1];
  return typeof last?.id === "string" ? last.id : undefined;
}

/**
 * 境界 entry までの複製。境界が未指定 (境界の時点で entry 0 件) は空、指定された境界が
 * 読み直した記録に無ければ undefined (中途半端な履歴を子へ書かない)。
 */
function copiedEntries(entries: SessionEntryLike[], boundaryId: string | undefined): SessionEntryLike[] | undefined {
  if (boundaryId === undefined) return [];
  const index = entries.findIndex((entry) => entry.id === boundaryId);
  return index === -1 ? undefined : entries.slice(0, index + 1);
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
      ...(agent.allowNaturalInvocationBuiltin === false ? { allowNaturalInvocationBuiltin: false } : {}),
      ...(agent.allowNaturalInvocationFile === false ? { allowNaturalInvocationFile: false } : {}),
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
  /**
   * bash の外向き TCP 443 を開いてよいセッション (メモリのみ)。abort と会話削除で未承認へ戻し、
   * 再起動では失われる (DB へ保存しない)。
   */
  networkAccess: NetworkAccessApprovals = new NetworkAccessApprovals();
  /**
   * 会話ごとの user 注入回数 (拒否の抑止を解く世代)。record は引き継ぎ (move) と resolve で
   * 作り直されるため、record に持つとカウンタが 0 に戻って残った拒否と一致してしまう
   */
  private readonly inputGenerations = new Map<string, number>();
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
  /** serve の成功実績。null は一覧の `serveCommand` を常に null にする */
  serveCommands: ServeCommandLookup | null;
  /** 応答メトリクスの保存先。null は保存も読み戻しもしない */
  assistantMetrics: AssistantMetricsStore | null;
  rootCwd: string;
  /** ストア上のメタデータ。live な record の分も持つ */
  descriptors: Map<string, SessionMeta>;
  /** id ごとのライフサイクル (load / evict)。完了まで同じ id の再ロードを待たせる */
  lifecycle: Map<string, Promise<unknown>>;
  /** 未ロード会話の meta-only 更新。タイトル・通知・ピン間で保存コピーを直列化する */
  metaUpdates: KeyedSerialLock<string>;
  /** 同一会話のピン更新。save / restore / delete と競合しないよう直列化する */
  pinUpdates: KeyedSerialLock<string>;
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
  /** 会話タイトルの AI 要約。null は要約しない */
  titleSummary: TitleSummaryHost | null;
  /** 補助呼び出しの共有枠 (同時実行数・待ち期限) */
  titleSummaryQueue: TitleSummaryQueue;
  /** AI 要約の進行 (判定・予約・順番待ち・適用・取消)。状態の遷移はこちらが持つ */
  private readonly titleProgress: TitleSummaryProgress;
  /** 送信対応記録の書込み (テスト差し替え用) */
  writeSendsFile: (storeDir: string, id: string, sends: SessionSends) => void;
  /** 保存経路 (meta / JSONL / 送信対応記録)。順序と失敗時の扱いはこちらが持つ */
  private readonly recordWrites: SessionRecordWrites;
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
    serveCommands,
    assistantMetrics,
    rootCwd,
    notifications,
    writeSends,
    titleSummary,
    titleSummaryQueue,
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
    this.serveCommands = serveCommands ?? null;
    this.assistantMetrics = assistantMetrics ?? null;
    this.rootCwd = rootCwd ?? process.cwd();
    this.notifications = notifications ?? null;
    this.titleSummary = titleSummary ?? null;
    this.titleSummaryQueue = titleSummaryQueue ?? new TitleSummaryQueue();
    this.titleProgress = new TitleSummaryProgress({
      masker: this.masker,
      isLive: (record) => this.records.get(record.id) === record,
      assertLive: (record) => this.assertRecordLive(record),
      isBusy: (record) => this.isBusy(record),
      isRunning: (record) => this.runInProgress(record),
      persist: (record) => this.persist(record, { jsonl: false }),
      resync: (record) => {
        this.emitResync(record);
      },
      host: () => this.titleSummary,
      queue: () => this.titleSummaryQueue,
      storeDir: () => this.storeDir,
      descriptors: () => this.descriptors,
    });
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
    this.metaUpdates = new KeyedSerialLock();
    this.pinUpdates = new KeyedSerialLock();
    this.deleting = new Set();
    this.handoffSaves = new WeakMap();
    this.pendingMoves = new Set();
    this.closing = false;
    this.sweeping = false;
    this.recordWrites = new SessionRecordWrites({
      storeDir: () => this.storeDir,
      rootCwd: this.rootCwd,
      // クリアの確定待ちの record は旧履歴を書き戻さない (確定前にだけ戻す)
      isLive: (record) =>
        !record.clearingHistory && !this.deleting.has(record.id) && this.records.get(record.id) === record,
      rememberMeta: (meta) => {
        this.descriptors.set(meta.id, meta);
      },
      writeSendsFile: (storeDir, id, sends) => this.writeSendsFile(storeDir, id, sends),
    });
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
    await this.titleProgress.recoverInterruptedAttempts();
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
    const placement = this.placementOf({ id, ...(project ? { projectCwd: project.cwd } : {}), spaceId });
    const workdir = placement.workdir;
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
      // 自然文での発火はスコープごとに索引を落とす (ビルトインは id で両方 false に倒す)
      allowNaturalInvocationBuiltin: allowsNaturalInvocation(agentInfo, "builtin"),
      allowNaturalInvocationFile: allowsNaturalInvocation(agentInfo, "file"),
      // ツールの許可リストも作成時に確定して meta へ保存する (復元はこれをスナップショットとして使う)
      ...(agentInfo.toolNames === undefined ? {} : { toolNames: agentInfo.toolNames }),
      model: model ?? agent.model,
      thinkingLevel: thinkingLevel ?? agent.thinkingLevel,
      cwd: workdir,
      // 承認の key は SDK のセッション id。永続化の有無で食い違うと、承認要求が record に届かないため、
      // 永続化なしでも同じ id を渡す (investigate の子は createChildSession が別 id を発行する)
      sessionId: id,
      // 所有権の束縛は永続化の有無に依らない (serve ツールは常に会話 id を持つ)
      ownerSessionId: id,
      promptSnapshot,
      // 参照画像の添付許可範囲。保存先はスペースで変わるため、ここで確定した値をツールへ渡す
      uploadsDirRel: placement.uploads,
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
    titleOrigin,
    titleAttempt,
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
    titleOrigin?: TitleOrigin;
    titleAttempt?: TitleAttempt;
    createdAt: number;
    notify: boolean;
    pinned?: boolean;
  }): SessionRecord {
    // 既存タイトルは手動として保護し (titleOriginOf)、新規は空タイトルから自動生成で始まる
    const origin = titleOrigin ?? titleOriginOf({ title });
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
      ...(titleAttempt ? { titleAttempt } : {}),
      ...(origin ? { titleOrigin: origin } : {}),
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
      titleOrigin: origin,
      ...(titleAttempt ? { titleAttempt } : {}),
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
      savedMetrics: new Map(),
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
      clearingHistory: false,
      compacting: false,
      notify,
      pinned,
    };
  }

  private async ensureWorkdir(workdirRel: string): Promise<void> {
    if (!workdirRel) return;
    if (!this.workspace) throw httpError(503, SANDBOX_SETUP_REQUIRED_MESSAGE);
    await this.workspace.createDir(workdirRel);
  }

  /**
   * 会話の配置 (root 相対) を決める唯一の入口。作業フォルダは所属があれば登録ディレクトリ、無ければ
   * 共有の持ち主 (`workdirOwner`。省略 = 自分) のスクラッチ。添付も同じ持ち主 (`uploadsOwner`) を辿る。
   * 分岐した子は親の id を持つため、id から導出する 1 箇所をここに寄せる。
   */
  private placementOf(meta: {
    id: string;
    spaceId?: string;
    projectCwd?: string;
    workdirOwner?: string;
    uploadsOwner?: string;
  }): { workdir: string; uploads: string } {
    const spaceId = meta.spaceId ?? "default";
    return {
      workdir: meta.projectCwd ?? this.scratchOf(meta.workdirOwner ?? meta.id, spaceId),
      uploads: sessionUploadsRel(meta.uploadsOwner ?? meta.id, spaceId),
    };
  }

  /**
   * 未所属のスクラッチ (root 相対)。root ("") になるのは永続化なしの既定スペースだけ
   * (既存のテスト・未設定デプロイ)。
   */
  private scratchOf(id: string, spaceId = "default"): string {
    return this.storeDir || spaceId !== "default" ? sessionWorkdirRel(id, spaceId) : "";
  }

  /** 添付の保存先 (root 相対)。route の添付検証はこの 1 つを通す (子は親の置き場を共有する) */
  uploadsOf(record: SessionRecord): string {
    return this.placementOf(record.meta).uploads;
  }

  /** 作業フォルダの持ち主。省略 = 自分 */
  private workdirOwnerOf(meta: { id: string; workdirOwner?: string }): string {
    return meta.workdirOwner ?? meta.id;
  }

  /** 添付の持ち主。省略 = 自分 */
  private uploadsOwnerOf(meta: { id: string; uploadsOwner?: string }): string {
    return meta.uploadsOwner ?? meta.id;
  }

  /**
   * 同じ作業フォルダ / 添付を共有している他の会話があるか (live / 未ロードの両方)。
   * 引き継ぎでフォルダを運ぶと共有相手の居場所を失うため、別スペース移動を止める根拠にする。
   */
  private sharesPlacement(id: string, workdir: string, uploads: string): boolean {
    for (const [otherId, placement] of this.placements()) {
      if (otherId === id) continue;
      if (placement.workdir === workdir || placement.uploads === uploads) return true;
    }
    return false;
  }

  private *placements(): Generator<[string, { workdir: string; uploads: string }]> {
    const seen = new Set<string>();
    for (const record of this.records.values()) {
      seen.add(record.id);
      const placement = this.placementOf(record.meta);
      // live の workdir は SDK へ渡した値が正 (プロジェクト解除などで meta とずれていても後勝ちにしない)
      yield [record.id, { workdir: record.workdir || placement.workdir, uploads: placement.uploads }];
    }
    for (const meta of this.descriptors.values()) {
      if (seen.has(meta.id)) continue;
      yield [meta.id, this.placementOf(meta)];
    }
  }

  /**
   * 分岐の前に親の作業フォルダの存在を確かめる。未ロードの会話は復元 (`load`) が未所属のスクラッチを
   * mkdir するため、解決より先にここで検査しないと「フォルダが無い」を空フォルダの作成で隠す。
   * 未知の id は何もしない (404 は解決する側が返す)。
   */
  async requireForkWorkdir(id: string): Promise<void> {
    const meta = this.records.get(id)?.meta ?? this.descriptors.get(id);
    if (!meta) return;
    await this.requireSharedWorkdir(this.placementOf(meta).workdir);
  }

  /**
   * 共有している作業フォルダの存在確認。無ければ 409 にして空フォルダを作らない
   * (作ると「ファイルが消えた」ように見える)。
   */
  private async requireSharedWorkdir(workdir: string): Promise<void> {
    if (!this.workspace) throw httpError(503, SANDBOX_SETUP_REQUIRED_MESSAGE);
    try {
      await this.workspace.listFiles(workdir);
    } catch (error) {
      if (error instanceof SandboxRequestError && error.status === 404) {
        throw httpError(409, SHARED_PLACEMENT_MISSING_MESSAGE);
      }
      throw httpError(sandboxFailureStatus(error), messageFor(error));
    }
  }

  /**
   * 登録ディレクトリの存在確認。セッション作成では mkdir しない (誤った cwd を黙って作らない)。
   * サンドボックスの 404 は「登録したディレクトリが消えた」なので 400 に寄せる。永続化なしは作業フォルダを
   * 持たないため確認せず、プレビュー (GET /api/skills/session) も作成と同じ条件でここを呼ぶ。
   */
  async requireProjectDir(cwd: string): Promise<void> {
    if (!this.storeDir) return;
    if (!this.workspace) throw httpError(503, SANDBOX_SETUP_REQUIRED_MESSAGE);
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
    // 引き継ぎ / 履歴クリアの確定後に残った履歴は、SDK セッションを作る前に片付ける。削除に失敗し続ける間は
    // 開く要求を 409 で拒否し、一覧には残す (DELETE は可能)。旧データを一瞬でも履歴へ戻さない。
    let current = meta;
    if (meta.handoffCleanup || meta.historyCleanup) {
      try {
        await removeSessionHistory(this.storeDir as string, id);
      } catch (error) {
        throw httpError(
          409,
          meta.handoffCleanup
            ? `引き継ぎの片付けが残っています。会話履歴を削除できませんでした: ${messageFor(error)}`
            : `会話履歴の片付けが残っています。旧履歴を削除できませんでした: ${messageFor(error)}`,
        );
      }
      this.deleteAssistantMetrics(id);
      current = { ...meta };
      delete current.handoffCleanup;
      delete current.historyCleanup;
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
    // 自分だけのスクラッチは作って保証し、共有している会話 (owner 付き) は作らずに存在を確かめる。
    // プロジェクト所属でも、持ち主が別の会話ならそのフォルダを mkdir しない
    const placement = this.placementOf(current);
    const workdir = placement.workdir;
    if (this.workdirOwnerOf(current) !== id) await this.requireSharedWorkdir(workdir);
    else if (!current.projectCwd) await this.ensureWorkdir(workdir);
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
      // 自然文での発火もスナップショットから決める (旧 meta に値が無いビルトインは id で false に倒す)
      allowNaturalInvocationBuiltin: allowsNaturalInvocation(current.agent, "builtin"),
      allowNaturalInvocationFile: allowsNaturalInvocation(current.agent, "file"),
      // ツールの許可リストも定義を引き直さず、セッションのスナップショットから渡す
      ...(current.agent.toolNames === undefined ? {} : { toolNames: current.agent.toolNames }),
      model: restored.model,
      thinkingLevel: restored.thinkingLevel,
      cwd: workdir,
      // 参照画像の添付許可範囲は復元でも同じ解決から組み立てる (子は親の置き場を共有する)
      uploadsDirRel: placement.uploads,
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
      titleOrigin: titleOriginOf(current),
      ...(current.titleAttempt ? { titleAttempt: current.titleAttempt } : {}),
      createdAt: current.createdAt,
      notify: current.notify === true,
      pinned: current.pinned === true,
    });
    record.lastUsedAt = current.lastUsedAt;
    record.meta = current;
    if (current.titleRequest) record.titleRequest = current.titleRequest;
    // 所属は保存値から復元し、projectId だけを読み取り時に解決する
    record.projectCwd = current.projectCwd;
    record.projectName = current.projectName;
    record.projectId = this.projectIdOfCwd(current.projectCwd);
    // 実測は再起動・sweep でメモリから消えるため、DB に写した行を応答IDで引き当てる
    record.savedMetrics = this.loadSavedMetrics(id);
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
    // 予約 (pending) のまま落ちたプロセスを再開した場合、実行中の task は存在しない。
    // 永久に「実行中」と見せず、再起動で中断したことを残す (自動の再試行はしない)
    const settledAttempt = settledTitleAttemptOf(record.titleAttempt);
    if (record.titleAttempt?.state === "pending" && settledAttempt) {
      record.titleAttempt = settledAttempt;
      await this.persist(record, { jsonl: false });
    }
    // 突き合わせの結果を書き直す (書けなければ dirty のまま残り、次の persist / flush で再試行する)
    if (record.sendsDirty) this.recordWrites.writeSends(record);
    // 実効モデルのフォールバックは model_change の追記ごと保存する。件数の補正だけなら履歴は同じ
    // なので、writer を通さず meta だけを書き戻す (履歴が同じでも writer は全量を書き直す)
    const backfillCount =
      current.messageCount !== displayableMessages(session, workspaceAbs(this.rootCwd, record.workdir)).length;
    if (modelRecorded) await this.persist(record);
    else if (backfillCount || meta.handoffCleanup || meta.historyCleanup) await this.persist(record, { jsonl: false });
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
    const candidate = [recordedModel, parseModelRef(meta.model)].find(
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
   * DB に写した実測を、応答ID -> 復元値の Map へ読む。読めないときに空で済ませるのは、
   * メタが出ないだけで会話は開けるため (復元は概算表示へ戻る)。
   */
  private loadSavedMetrics(id: string): Map<string, MessageMetrics> {
    const saved = new Map<string, MessageMetrics>();
    const store = this.assistantMetrics;
    if (!store) return saved;
    try {
      for (const row of store.loadAssistantMetrics(id)) {
        const metrics = computeMessageMetrics({
          durationMs: row.durationMs,
          ...(row.ttftMs === null ? {} : { ttftMs: row.ttftMs }),
          outputTokens: row.outputTokens ?? undefined,
        });
        if (metrics) saved.set(row.assistantId, metrics);
      }
    } catch {
      saved.clear();
    }
    return saved;
  }

  /**
   * 応答 1 件分の実測を DB へ写す。message_end の通知中に書かないのは、JSONL の保存と同じく
   * 履歴の確定と順序を合わせる必要がないため。失敗してもランは止めず、status にも載せない。
   */
  private queueAssistantMetrics(
    record: SessionRecord,
    assistantId: string,
    message: PiSessionMessageLike,
    metrics: MessageMetrics,
  ): void {
    const store = this.assistantMetrics;
    if (!store) return;
    const row = assistantMetricsRowOf(record.id, assistantId, message, metrics);
    if (!row) return;
    queueMicrotask(() => {
      // 削除済みの会話へ書き戻さない (行だけが孤児として残る)
      if (this.deleting.has(record.id) || this.records.get(record.id) !== record) return;
      try {
        store.recordAssistantMetrics(row);
      } catch (error) {
        console.warn(`[u7agent] assistant metrics save failed: ${this.masker.mask(messageFor(error))}`);
      }
    });
  }

  /** 履歴の削除が成功した後にだけ呼ぶ。先に消すと、残った履歴から引けない行だけが消える */
  private deleteAssistantMetrics(id: string): void {
    try {
      this.assistantMetrics?.deleteAssistantMetrics(id);
    } catch (error) {
      // 孤児行は残り得るが、セッションの削除を失敗にしない
      console.warn(`[u7agent] assistant metrics delete failed: ${this.masker.mask(messageFor(error))}`);
    }
  }

  /** 実行中でも切り替えられ、通知するかどうかは finish 時点の値で決まる。 */
  async setNotify(id: string, notify: boolean): Promise<SessionNotifyResponse | undefined> {
    // 復元中の id は完了を待つ (descriptor を先に書き換えると load の meta で上書きされる)
    const pending = this.lifecycle.get(id);
    if (pending) await pending.catch(() => {});
    const live = this.records.get(id);
    if (live) {
      live.notify = notify;
      await this.persist(live, { jsonl: false });
      // 保存失敗を成功扱いにしない (in-memory の実行は止めないが、この応答は 500)
      if (live.persistError) throw httpError(500, `セッションの保存に失敗しました: ${live.persistError}`);
      return { sessionId: live.id, notify: live.notify };
    }
    return this.updateUnloadedMeta(
      id,
      (meta) => {
        if (notify) meta.notify = true;
        else delete meta.notify;
      },
      { sessionId: id, notify },
    );
  }

  /** ランタイムが使えない間も更新できるよう、SDK セッションは開かない。 */
  private updateUnloadedMeta<T>(id: string, update: (meta: SessionMeta) => void, response: T): Promise<T | undefined> {
    return this.metaUpdates.run(id, async () => {
      if (this.deleting.has(id) || this.closing) return undefined;
      // 待機前に読んだ descriptor を使うと、先行した更新を上書きしてしまう。
      const meta = this.descriptors.get(id);
      if (!meta || !this.storeDir) return undefined;
      const updated: SessionMeta = { ...meta };
      update(updated);
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
      return response;
    });
  }

  /** ピン留めは SDK の設定・履歴・最終使用時刻に触れず、live / 未ロードとも meta だけを更新する。 */
  setPinned(id: string, pinned: boolean): Promise<SessionPinnedResponse | undefined> {
    return this.pinUpdates.run(id, () => this.setPinnedState(id, pinned));
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
    return this.updateUnloadedMeta(
      id,
      (meta) => {
        if (pinned) meta.pinned = true;
        else delete meta.pinned;
      },
      { sessionId: id, pinned },
    );
  }

  /** 通知トグルと同様、実行中でも改名できる。 */
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
      // 手動改名を正とする。進行中の AI 要約は費用をかけ続けないよう取り消し、届いた結果も捨てる
      live.titleOrigin = "manual";
      this.titleProgress.cancel(live);
      await this.persist(live, { jsonl: false });
      if (live.persistError) throw httpError(500, `セッションの保存に失敗しました: ${live.persistError}`);
      return { sessionId: live.id, title: live.title };
    }
    return this.updateUnloadedMeta(
      id,
      (meta) => {
        meta.title = next;
        meta.titleOrigin = "manual";
      },
      { sessionId: id, title: next },
    );
  }

  async updateSettings(record: SessionRecord, input: UpdateSessionSettingsInput): Promise<SessionPayload> {
    this.assertRecordLive(record);
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
      throw httpError(400, `Model is not available: ${formatModelRef(input.model)}`);
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
    // 新しいスナップショットが正になるため、保留中の thinking 末尾は配らない (次の delta で戻る)
    record.run?.cancelThinking?.();
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
   * クリア / 移動 / 削除の後に残った record へ書き込まない。await を挟む route が古い参照を持っていると、
   * 消した履歴へ実行や保存を始めてしまうため、副作用の直前にもう一度確かめる。
   */
  private assertRecordLive(record: SessionRecord): void {
    if (this.closing) throw httpError(503, "サーバーを終了しています");
    if (this.records.get(record.id) !== record || record.clearingHistory || this.deleting.has(record.id)) {
      throw httpError(409, "会話の状態が変わったため操作できません。開き直してから、もう一度お試しください");
    }
  }

  /**
   * 実行中なら追加入力としてBFFの配送キューへ積み、それ以外は即座にランを始める。`titleSource` は
   * 一覧のタイトルの元本文で、省略時は text。定型プロンプトの結合前の本文が渡され、`/skill:` の
   * 展開結果は長いため、展開前のユーザー入力からタイトルを作るために使う。`sendId` は未送信メッセージの
   * 再送で、受理済みの送信IDを引き継ぐ。
   */
  postMessage(
    record: SessionRecord,
    text: string,
    options: { titleSource?: string; sendId?: string; skillCommandRecognized?: boolean } = {},
  ): PostMessageResultInternal {
    this.assertRecordLive(record);
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
      // 依頼本文 (定型プロンプトの結合前・スキル参照の展開前) から認識したスキル参照だけを外す。
      // 秘密値はタイトルにも AI 要約の入力にも残さないよう、ここで 1 回だけマスクする
      const request = this.masker.mask(
        titleRequestOf(stripAttachedFiles(options.titleSource ?? text), {
          skillCommandRecognized: options.skillCommandRecognized === true,
        }),
      );
      record.titleRequest = request;
      record.meta.titleRequest = truncate(request, TITLE_REQUEST_MAX);
      record.title = normalizeTitleText(request);
      record.titleOrigin = "auto";
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
        this.recordWrites.writeSends(record);
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
    this.assertRecordLive(record);
    const index = record.unsentSends.findIndex((item) => item.sendId === sendId);
    if (index === -1) return "missing";
    if (this.isSendActive(record, sendId)) return "running";
    record.unsentSends.splice(index, 1);
    record.sendsDirty = true;
    this.recordWrites.writeSends(record);
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
    this.assertRecordLive(record);
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
      this.recordWrites.writeSends(record);
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
        this.recordWrites.writeSends(record);
        // 受付ごとではなくチェーン完了後に 1 回だけ配る (N 件の受理で payload を N 回配らない)
        this.emitResync(record);
      })
      .finally(() => {
        if (record.steerTask === task) delete record.steerTask;
      });
    record.steerTask = task;
  }

  /**
   * この引数の `request_network_access` が承認カードを出すか。ライブ配信とツール本体が同じ判定を通る
   * (どちらかだけ別の条件にすると、カードを出さなかった要求が片側にだけ残る)
   */
  showsNetworkAccessCard(sessionId: string, args: unknown): boolean {
    return (
      networkAccessOutcome({
        mode: networkAccessMode(),
        sessionId,
        host: deriveNetworkAccessQuestions(args)?.[0]?.host,
        approved: this.networkAccess.isApproved(sessionId),
        isDenied: (id, host) => this.networkAccess.isDenied(id, host, this.inputGeneration(id)),
      }).kind === "ask"
    );
  }

  /** 拒否の抑止を解く世代 (user メッセージの注入回数)。record より長く持ち、削除で捨てる */
  inputGeneration(sessionId: string): number {
    return this.inputGenerations.get(sessionId) ?? 0;
  }

  /**
   * user メッセージの注入を観測し、送信IDと実行IDを対応付ける。SDK は実キューから取り出した順に
   * user を渡すため、開始送信の次に届く user は控えている `handedOff` の先頭で、本文一致に依存せず
   * 対応が取れる。取り出しの印は実キュー件数から導出するため、ここでは立てない。
   * ディスク保存を待たず resync を配り、次の assistant の delta より先に新しい user を見せる。
   */
  private noteUserInjected(record: SessionRecord, run: RunState, message: object): void {
    // 拒否の抑止を解く世代。対応の取れない user でも「モデルへ入った新しい入力」なので数える
    this.inputGenerations.set(record.id, this.inputGeneration(record.id) + 1);
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
      this.recordWrites.writeSends(record);
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
      this.recordWrites.writeSends(record);
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
    this.recordWrites.writeSends(record);
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
    this.recordWrites.writeSends(record);
  }

  /**
   * 実行中のランを中断し、未配信の入力を未送信として回収する。新規の送信は先に止め、SDK の受付処理
   * (steer) と取消の完了を待ってから実キューを捨て、abort の完了後に積み残しを再確認する。停止後は
   * 自動配送しない (回収した入力は手動の再送 / 破棄に任せる)。
   */
  async stop(record: SessionRecord): Promise<{ ok: true; status: RunStatus }> {
    this.assertRecordLive(record);
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
      // 承認は run の実行状態に依らず停止で未承認へ戻す (何も走っていないときの停止も同じ意図)
      const approvalChanged = this.networkAccess.isApproved(record.id);
      this.networkAccess.revoke(record.id);
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
      this.recordWrites.writeSends(record);
      // 回収で待機や未送信の割当が変わったときだけ、購読者の表示を揃える。承認を失効したときも
      // payload の networkAccess を配り直す (押したカードを許可済みのままにしない)
      if (cleared.length + stragglers.length > 0 || released || approvalChanged) this.emitResync(record);
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
      this.recordWrites.writeSends(record);
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
   * egress ポリシーの実体。モードは env から毎回読み (既定 `allow`)、承認はこのストアのメモリに置く。
   * 承認の key は SDK のセッション id なので、investigate の子は親と別の id を持ち承認を継承しない。
   */
  networkAccessHost(): NetworkAccessHost {
    return {
      allows: (sessionId) => this.networkAccess.allows(sessionId),
      mode: () => networkAccessMode(),
      isApproved: (sessionId) => this.networkAccess.isApproved(sessionId),
      isDenied: (sessionId, host) => {
        // record を引けないときは抑止しない。拒否の記録は record と同じ寿命でしか意味を持たず、
        // この後 ask が Session not found で断る
        return this.networkAccess.isDenied(sessionId, host, this.inputGeneration(sessionId));
      },
      ask: (sessionId, toolCallId, questions, signal) => {
        const record = this.records.get(sessionId);
        if (!record) return Promise.reject(new Error(`Session not found: ${sessionId}`));
        return this.askQuestion(record, toolCallId, questions, signal, "network_access");
      },
    };
  }

  /**
   * 拒否済みの承認カードから、モデルを介さずに許可へ変える。モデルが再要求しないと救済できない
   * 状態を、ユーザーの直接の判断で開くための経路 (docs/sandbox.md)。承認は会話単位なので 443 全体が開き、
   * 押したカードのホストの拒否記録だけを消す (ほかのホストの記録は #2452 でホスト単位になるまで残す)。
   */
  approveDeniedNetworkAccess(
    record: SessionRecord,
    rawHost: string,
  ): { status: "ok"; host: string; mode: NetworkAccessMode } | { status: "invalid-host" } | { status: "disabled" } {
    const host = normalizeNetworkAccessHost(rawHost);
    if (host === "") return { status: "invalid-host" };
    const mode = networkAccessMode();
    if (mode === "deny") return { status: "disabled" };
    record.lastUsedAt = Date.now();
    this.networkAccess.approve(record.id);
    this.networkAccess.clearDenial(record.id, host);
    // 承認の状態は payload に載る。別タブと、押したカード自身の表示を揃える
    if (mode === "ask") this.emitResync(record);
    return { status: "ok", host, mode };
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
    kind: PendingQuestionKind = "ask_user",
  ): Promise<AskUserAnswer[]> {
    return new Promise<AskUserAnswer[]>((resolve, reject) => {
      const pending: PendingQuestion = {
        questions: [...questions],
        kind,
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
    this.assertRecordLive(record);
    record.lastUsedAt = Date.now();
    const pending = record.questions.get(toolCallId);
    if (!pending) return { status: "missing" };
    if (pending.settled) return { status: "answered" };
    const error = validateAskUserAnswers(pending.questions, answers, pending.kind);
    if (error) return { status: "invalid", error };
    // 質問順に揃える (details / モデル向け text の並びを送信順に依存させない)
    const ordered = [...answers].sort((a, b) => a.index - b.index);
    // 承認は回答の受理時に BFF 側で記録する。ツールの戻り値やラベル文字列から確定しない
    let approvalChanged = false;
    if (pending.kind === "network_access") {
      if (approvalOf(ordered[0])) {
        approvalChanged = !this.networkAccess.isApproved(record.id);
        this.networkAccess.approve(record.id);
        // 承認は 443 全体を開くので、ホストごとの拒否の記録は残さない
        this.networkAccess.clearDenials(record.id);
      } else {
        approvalChanged = this.networkAccess.isApproved(record.id);
        this.networkAccess.revoke(record.id);
        // 拒否はカードに出た接続先だけの話。別ホストは次の確認として通す
        const host = pending.questions[0]?.host;
        if (host !== undefined) this.networkAccess.recordDenial(record.id, host, this.inputGeneration(record.id));
      }
    }
    settleQuestion(pending, () => pending.resolve(ordered));
    // 承認の実効が変わったら、回答していないクライアントの表示も揃える。カードを出さない判断は
    // payload の networkAccess を読むため、古いままだと済んだ承認を聞き直す表示が残る
    if (approvalChanged) this.emitResync(record);
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
   * 開始 / 終端の配信順序と失敗の分類は docs/compaction.md / docs/api-session-runtime.md を正とする。
   */
  async compact(record: SessionRecord): Promise<SessionCompactionResult> {
    this.assertRecordLive(record);
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
    // 購読の確立 / リプレイの前に、保留中の thinking 末尾を配らない (古い tail を復元しない)。
    // masker は残るため、次の delta は普通に配れる
    record.run?.cancelThinking?.();
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
        // リプレイは phase の status だけを復元する。live の thinking 末尾は過去の delta から作れず、
        // 古い tail を再表示しないため落とす
        send(withoutThinking(entry));
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
      networkAccess: { mode: networkAccessMode(), approved: this.networkAccess.isApproved(record.id) },
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
      hasRawLog: this.hasRawLogOf(record.id, record.storeDir, record.meta),
      serveCommand: this.serveCommandOf(record.workdir),
    });
  }

  /**
   * その作業ディレクトリの serve 成功実績。cwd を共有するプロジェクト会話は同じ値を返し、
   * 実績が無い会話は null (他ディレクトリの実績は返さない)。
   */
  private serveCommandOf(workdir: string): ServeCommand | null {
    const stored = this.serveCommands?.getServeCommand(workdir);
    return stored ? { cwd: stored.cwd, command: stored.command } : null;
  }

  /**
   * 生ログ (session.jsonl) がディスクにあるか。一覧の「生ログをダウンロード」の出し分けに使う。
   * 片付け待ちの会話は、ファイルが残っていても古い履歴を配らないため無いものとして扱う。
   */
  private hasRawLogOf(id: string, storeDir: string, meta?: SessionMeta): boolean {
    if (meta?.handoffCleanup || meta?.historyCleanup) return false;
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
    const meta = this.records.get(id)?.meta ?? this.descriptors.get(id);
    if (!meta) return { state: "unknown" };
    // 片付け待ちは、ファイルが残っていても旧データを返さない (開く要求と同じ扱い)
    if (meta.handoffCleanup || meta.historyCleanup) return { state: "missing" };
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
          title: { origin: record.titleOrigin, ...(record.titleAttempt ? { attempt: record.titleAttempt } : {}) },
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
    const metaAttempt = settledTitleAttemptOf(meta.titleAttempt);
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
        title: { origin: titleOriginOf(meta), ...(metaAttempt ? { attempt: metaAttempt } : {}) },
        meta: {
          spaceId: meta.spaceId ?? "default",
          agentId: meta.agentId,
          agentName: meta.agent.name,
          ...(this.projectIdOfCwd(meta.projectCwd) ? { projectId: this.projectIdOfCwd(meta.projectCwd) } : {}),
          ...(meta.projectName ? { projectName: meta.projectName } : {}),
          workdir: this.placementOf(meta).workdir,
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
      titleSummary: titleSummaryOf(
        { origin: titleOriginOf(meta), attempt: settledTitleAttemptOf(meta.titleAttempt) },
        this.masker,
      ),
      agentId: meta.agentId,
      agentName: meta.agent.name,
      status: "idle",
      queueDepth: 0,
      notify: meta.notify === true,
      pinned: meta.pinned === true,
      canHandoff: true,
      projectSession: meta.projectCwd !== undefined,
      ...(meta.handoffCleanup ? { handoffCleanup: true } : {}),
      ...(meta.historyCleanup ? { historyCleanup: true } : {}),
      hasRawLog: this.hasRawLogOf(meta.id, this.storeDir ?? "", meta),
      serveCommand: this.serveCommandOf(this.placementOf(meta).workdir),
      messageCount: meta.messageCount,
      createdAt: meta.createdAt,
      lastUsedAt: meta.lastUsedAt,
      ...(meta.model ? { model: meta.model } : {}),
      ...(this.projectIdOfCwd(meta.projectCwd) ? { projectId: this.projectIdOfCwd(meta.projectCwd) } : {}),
      ...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
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
    return this.placementOf(meta).workdir;
  }

  /**
   * 同じ作業フォルダを使う live の会話に実行中 (実行 / キュー待ち / 圧縮) のものがあるか。
   * プロジェクト会話は同じ `projectCwd` を全セッションで共有するため、自分の会話が idle でも
   * 兄弟会話が成果物を書き換えていることがある。未所属の会話は会話ごとの scratch なので、
   * 自分の会話以外と一致しない。live でない会話に run は無い (SDK セッションは開かない)。
   */
  busyInWorkdir(workdir: string): boolean {
    for (const record of this.records.values()) {
      if (record.workdir === workdir && this.isBusy(record)) return true;
    }
    return false;
  }

  spaceOfId(id: string): string | undefined {
    const meta = this.records.get(id)?.meta ?? this.descriptors.get(id);
    return meta ? (meta.spaceId ?? "default") : undefined;
  }

  /**
   * 会話がプロジェクト配下か。保存値の `projectCwd` の有無で判定し、`projectId` の解決結果は使わない
   * (登録解除で `projectId` が undefined に戻るため)。未知の会話は undefined。
   */
  projectCwdOfId(id: string): string | undefined {
    const live = this.records.get(id);
    if (live) return live.projectCwd;
    return this.descriptors.get(id)?.projectCwd;
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
      // 承認は live な record の有無に依らず消す (sweep 済みの会話も消せる。同じ id の再利用へ持ち越さない)
      this.networkAccess.revoke(id);
      this.networkAccess.clearDenials(id);
      this.inputGenerations.delete(id);
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
      this.deleteAssistantMetrics(id);
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
      throw httpError(503, SANDBOX_SETUP_REQUIRED_MESSAGE);
    }
    const live = this.records.get(id);
    const meta = live?.meta ?? this.descriptors.get(id);
    if (!meta) return undefined;
    const fromSpace = meta.spaceId ?? "default";
    const moving = fromSpace !== target;
    if (meta.handoffCleanup) throw httpError(409, HANDOFF_CLEANUP_PENDING_MESSAGE);
    if (meta.historyCleanup) throw httpError(409, HISTORY_CLEANUP_PENDING_MESSAGE);
    // プロジェクト所属は作業ディレクトリが同じで移す先がないため、同じスペースへの引き継ぎだけを許す
    if (meta.projectCwd && moving) {
      throw httpError(400, "プロジェクト所属のセッションは同じ会話スペースへだけ引き継げます");
    }
    // スクラッチ以外 (projectCwd の残骸など) を動かさないための不変条件。スペースをまたぐ移動だけに適用し、
    // 同じスペースのエージェント交代はファイルを動かさないので owner を持つ子でも通す
    const placement = this.placementOf(meta);
    const fromWorkdir = live?.workdir ?? placement.workdir;
    const fromUploads = placement.uploads;
    // 同じ作業フォルダ / 添付を共有している会話があるなら別スペースへ運ばない。運ぶと共有相手の
    // owner が指すパスが消え、次に開いたときに空のフォルダを作って「ファイルが消えた」ように見える。
    // 子自身 (owner が自分でない) も、共有相手が既に消えていても同じ理由で断る
    if (moving && (this.workdirOwnerOf(meta) !== id || this.sharesPlacement(id, fromWorkdir, fromUploads))) {
      throw httpError(409, SHARED_PLACEMENT_MESSAGE);
    }
    if (moving && !meta.projectCwd && fromWorkdir !== this.scratchOf(id, fromSpace)) {
      throw httpError(400, "移動できるのはセッション専用の作業フォルダだけです");
    }
    if (live && (this.isBusy(live) || live.session.isStreaming || live.changingSettings)) {
      throw httpError(409, "実行中・キュー中・設定変更中のセッションは引き継げません");
    }

    const storeDir = this.storeDir;
    const files: HandoffMoveFiles = {
      storeDir,
      moveSandbox: this.moveSandbox,
      workspace: this.workspace,
      handoffSandbox: this.handoffSandbox,
      cwdKeys: this.cwdKeys,
    };
    // 移動先も owner 経由で解く (同じスペースの引き継ぎでは共有フォルダのまま、メモはそこへ書く)
    const toWorkdir = meta.projectCwd ?? this.scratchOf(this.workdirOwnerOf(meta), target);
    const toUploads = sessionUploadsRel(this.uploadsOwnerOf(meta), target);
    // 古い値の保存が移動後の meta を上書きしないよう、先に drain する
    if (live) await this.recordWrites.drain(live);
    // drain 中の setNotify / setTitle / setPinned を落とさないよう、最新の meta から組み立てる
    const current = live?.meta ?? this.descriptors.get(id) ?? meta;
    if (current.handoffCleanup) throw httpError(409, HANDOFF_CLEANUP_PENDING_MESSAGE);
    if (current.historyCleanup) throw httpError(409, HISTORY_CLEANUP_PENDING_MESSAGE);

    // 引き継ぎ先のエージェント。「指定なし」は保存済みのスナップショットを維持する (現在のエージェントが
    // カタログから消えていても引き継げる)。「指定あり」は現在と同じ id でも新規作成と同じ経路で解決し直し、
    // 定義の更新を反映し、未知・削除済みの id は 400 にする (UI の「現在」は id を省略する)
    const resolved = options.agentId === undefined ? undefined : resolveAgentSkills(this.catalog, options.agentId);
    const agentId = resolved?.agentInfo.id ?? current.agentId;
    const agentInfo = resolved?.agentInfo ?? current.agent;
    const promptSnapshot = resolved?.promptSnapshot ?? current.promptSnapshot;

    const operationId = generateHandoffOperationId();
    const at = Date.now();
    const prepared = memo
      ? await prepareHandoffMemo(files, {
          id,
          title: current.title,
          fromAgent: current.agent.name,
          toAgent: agentInfo.name,
          operationId,
          at,
          masker: this.masker,
          moving,
          fromWorkdir,
          toWorkdir,
        })
      : undefined;

    const updated: SessionMeta = {
      ...current,
      spaceId: target,
      lastUsedAt: at,
      messageCount: 0,
      agentId,
      agent: agentInfo,
      promptSnapshot,
      handoff: { operationId, at, memo: prepared !== undefined, consumed: false } satisfies SessionHandoffRecord,
      handoffCleanup: true,
    };
    const result = await applyHandoffMove(files, this.handoffMovePort(id, live, storeDir), {
      id,
      moving,
      fromWorkdir,
      fromUploads,
      toWorkdir,
      toUploads,
      updated,
      memo: prepared,
      live,
    });
    if (result.kind === "aborted") return undefined;
    if (live) {
      // 確定後の失敗は、応答だけでなく購読中のタブへ resync でも伝える (開けない理由を先に出す)
      if (result.cleanupPending) this.emitResync(live);
      this.closeSubscribers(live);
    }
    return {
      sessionId: id,
      title: updated.title || "無題のセッション",
      spaceId: target,
      memo: prepared !== undefined,
      cleanupPending: result.cleanupPending,
    };
  }

  /**
   * 引き継ぎの手順 (`handoff-move`) へ渡す口。private を公開せずに切り出すため、この場の closure にする。
   * `live` は手順の開始時の record で、確定後の片付けで open から外れるまで同じものを指す。
   */
  private handoffMovePort(id: string, live: SessionRecord | undefined, storeDir: string): HandoffMovePort {
    return {
      isAborted: () => this.moveAborted(id),
      saveMeta: async (meta) => {
        await writeSessionMeta(storeDir, meta);
        this.descriptors.set(id, meta);
        if (live) live.meta = meta;
      },
      releaseRecord: async (record) => {
        record.session.dispose?.();
        this.records.delete(id);
        // dispose 後の書込みを drain してから消す (削除後に書き戻されて未送信が復活しないように)
        await this.recordWrites.drain(record);
      },
      deleteAssistantMetrics: (sessionId) => this.deleteAssistantMetrics(sessionId),
    };
  }

  /** 削除予約 / close を検出する。引き継ぎの手順 (handoff-move) は各 await の後でこれを見てロールバックする */
  private moveAborted(id: string): boolean {
    return this.deleting.has(id) || this.closing;
  }

  /**
   * 会話履歴だけを破棄し、同じ ID / URL のまま空の履歴から再開できるようにする (スペース移動の
   * 引き継ぎとは別)。会話の行・所属・作業フォルダ / 添付・HANDOFF.md は残し、メッセージ・圧縮要約・
   * 未送信・生ログ・応答の実測だけを消す。SDK を開くのは live な会話だけで、未ロードは JSONL の
   * 設定記録だけを読む。`expectHistoryGeneration` は確認時点の履歴世代で、変わっていれば 409。
   */
  async clearHistory(
    id: string,
    { expectHistoryGeneration, expectSpaceId }: { expectHistoryGeneration: string; expectSpaceId: string },
  ): Promise<SessionHistoryClearResponse | undefined> {
    // 先行の load / meta 更新 / ピン更新を待ち、対象 ID 単位でクリアを予約する (move と同じ lifecycle)
    const operation = (async () => {
      for (const pending of [this.lifecycle.get(id), this.metaUpdates.get(id), this.pinUpdates.get(id)]) {
        if (pending) await pending.catch(() => {});
      }
      return this.clearSessionHistory(id, expectHistoryGeneration, expectSpaceId);
    })();
    const settled = operation.then(
      () => {},
      () => {},
    );
    this.lifecycle.set(id, settled);
    try {
      return await operation;
    } finally {
      if (this.lifecycle.get(id) === settled) this.lifecycle.delete(id);
    }
  }

  private async clearSessionHistory(
    id: string,
    expectHistoryGeneration: string,
    expectSpaceId: string,
  ): Promise<SessionHistoryClearResponse | undefined> {
    if (this.storeError) throw httpError(503, `会話ストアを利用できません: ${this.storeError}`);
    const storeDir = this.storeDir;
    if (!storeDir) throw httpError(503, "会話履歴のクリアには会話ストアが必要です");
    if (this.closing) throw httpError(503, "サーバーを終了しています");
    const live = this.records.get(id);
    let current = live?.meta ?? this.descriptors.get(id);
    if (!current) return undefined;
    this.assertHistoryClearable(current, live, expectHistoryGeneration, expectSpaceId);
    // 未ロードでも SDK セッションや作業フォルダは作らず、JSONL の設定記録と meta だけを照合する
    const restored = live ? this.effectiveInputsOf(live) : await this.clearedInputsOf(current);
    // 確定前に届いた古い保存 (タイトル要約を含む) を待ち、ここから先はもう書かない
    if (live) live.clearingHistory = true;
    let confirmed = false;
    try {
      if (live) await this.recordWrites.drain(live);
      // drain 中の setTitle / setNotify を落とさないよう、最新の meta から組み立て直す
      current = live?.meta ?? this.descriptors.get(id);
      if (!current) return undefined;
      this.assertHistoryClearable(current, live, expectHistoryGeneration, expectSpaceId);
      const inputs = live ? this.effectiveInputsOf(live) : restored;
      if (!this.hasHistoryToClear(current, live)) {
        // 現世代で消すものが無い。新しい世代も作らず、クライアントに自動再試行をさせない
        if (live) live.clearingHistory = false;
        return {
          sessionId: id,
          title: current.title || NO_UNTITLED_TITLE,
          historyGeneration: current.historyGeneration ?? "",
          changed: false,
        };
      }
      const historyGeneration = randomBytes(4).toString("hex");
      const keepTitle = titleOriginOf(current) === "manual";
      const updated: SessionMeta = {
        ...current,
        messageCount: 0,
        historyGeneration,
        historyCleanup: true,
        ...(inputs.model ? { model: inputs.model } : {}),
        ...(inputs.thinkingLevel ? { thinkingLevel: inputs.thinkingLevel } : {}),
        title: keepTitle ? current.title : "",
        titleOrigin: keepTitle ? "manual" : "auto",
        // 既存の引き継ぎメモは残し、未使用の参照チップだけを解除する (送信の受理と同じ印)
        ...(current.handoff ? { handoff: { ...current.handoff, consumed: true } } : {}),
      };
      delete updated.titleRequest;
      delete updated.titleAttempt;
      // ここが確定点。新しい履歴世代・片付け待ち・チップの解除を meta に同時に保存する
      await writeSessionMeta(storeDir, updated);
      confirmed = true;
      this.descriptors.set(id, updated);
      if (live) {
        live.meta = updated;
        live.title = updated.title;
        live.titleOrigin = keepTitle ? "manual" : "auto";
        delete live.titleAttempt;
        delete live.titleRequest;
        // 旧世代の AI 要約は取り消す (以後の結果・使用量は適用しない)
        this.titleProgress.cancel(live);
        this.emitHistoryCleared(live, updated);
      }
      // 確定後は旧 SDK と購読を閉じ、書込みが止まってから旧履歴を片付ける
      if (live) {
        // dispose の失敗で record を残すと、確定済みのまま操作できない状態になるため先に外す
        try {
          live.session.dispose?.();
        } catch {
          // 購読と書込みは下の drain と close で閉じる
        }
        this.records.delete(id);
        await this.recordWrites.drain(live);
      }
      let cleanupPending = false;
      try {
        await removeSessionHistory(storeDir, id);
      } catch {
        cleanupPending = true;
      }
      if (!cleanupPending) {
        this.deleteAssistantMetrics(id);
        const cleared: SessionMeta = { ...updated };
        delete cleared.historyCleanup;
        try {
          await writeSessionMeta(storeDir, cleared);
          this.descriptors.set(id, cleared);
          if (live) live.meta = cleared;
        } catch {
          // 確定は済んでいる。印が残るだけなので次の読み込み / 保存で再試行する
          cleanupPending = true;
        }
      }
      if (live) this.closeSubscribers(live);
      return {
        sessionId: id,
        title: updated.title || NO_UNTITLED_TITLE,
        historyGeneration,
        changed: true,
        cleanupPending,
      };
    } catch (error) {
      // 確定前の失敗は旧履歴を残し、保留した保存を解く (確定後は旧世代の結果を適用しない)
      if (!confirmed && live) live.clearingHistory = false;
      throw error;
    }
  }

  /** クリアを受け付けてよいか。busy / 片付け中 / 履歴世代の不一致は副作用の前に 409 にする */
  private assertHistoryClearable(
    meta: SessionMeta,
    live: SessionRecord | undefined,
    expectHistoryGeneration: string,
    expectSpaceId: string,
  ): void {
    // 待機の後に引っ越しが確定していたら、移動先の会話へクリアを効かせない (fork と同じ 404)
    if ((meta.spaceId ?? "default") !== expectSpaceId) throw httpError(404, "Session not found");
    if (this.closing) throw httpError(503, "サーバーを終了しています");
    if (this.deleting.has(meta.id)) throw httpError(409, "会話が削除されているため履歴を消せません");
    if (meta.handoffCleanup) throw httpError(409, HANDOFF_CLEANUP_PENDING_MESSAGE);
    if (meta.historyCleanup) throw httpError(409, HISTORY_CLEANUP_PENDING_MESSAGE);
    if (live) {
      const awaiting = [...live.questions.values()].some((pending) => !pending.settled);
      if (this.isBusy(live) || live.session.isStreaming || live.changingSettings || live.stopping || awaiting) {
        throw httpError(
          409,
          "実行中・回答待ち・キュー待ち・圧縮中・設定変更中・停止処理中のセッションは履歴を消せません",
        );
      }
    }
    if ((meta.historyGeneration ?? "") !== expectHistoryGeneration) throw httpError(409, HISTORY_CHANGED_MESSAGE);
  }

  /** live な会話の実効モデル / Effort。履歴を消す前に meta へ保存する */
  private effectiveInputsOf(record: SessionRecord): { model?: string; thinkingLevel?: string } {
    const model = modelLabel(record.session.model);
    return {
      ...(model ? { model } : {}),
      ...(record.session.thinkingLevel ? { thinkingLevel: record.session.thinkingLevel } : {}),
    };
  }

  /**
   * 未ロードの会話で、履歴の変更記録と meta を現行の復元規則で照合した設定。SDK セッションと作業フォルダは
   * 作らない。JSONL が破損していれば、meta だけでは後から行われた変更を確かめられないため 409 にする。
   */
  private async clearedInputsOf(meta: SessionMeta): Promise<{ model?: string; thinkingLevel?: string }> {
    const { parsed } = await readSessionFile(this.storeDir as string, meta.id);
    if (parsed.kind === "damaged") {
      throw httpError(
        409,
        `保存された会話を読めないため履歴を消せません (${parsed.reason})。復旧してから、もう一度お試しください`,
      );
    }
    const restored = this.restoreInputs(meta, parsed.kind === "ok" ? parsed.entries : []);
    const model = modelLabel(restored.model);
    return {
      ...(model ? { model } : {}),
      ...(restored.thinkingLevel ? { thinkingLevel: restored.thinkingLevel } : {}),
    };
  }

  /** 現世代で消すものが残っているか。空の会話と、手動タイトルだけの会話は変更なしとして扱う */
  private hasHistoryToClear(meta: SessionMeta, live: SessionRecord | undefined): boolean {
    // 未使用の参照チップもクリアで解除する対象 (履歴が無くてもチップは消す)
    if (meta.handoff && !meta.handoff.consumed) return true;
    if (live) {
      return (
        live.session.messages.length > 0 ||
        live.unsentSends.length > 0 ||
        live.titleRequest !== undefined ||
        live.titleAttempt !== undefined ||
        (live.titleOrigin !== "manual" && live.title !== "")
      );
    }
    if (this.storeDir && readSessionSends(this.storeDir, meta.id).unsent.length > 0) return true;
    return (
      meta.messageCount > 0 ||
      meta.titleRequest !== undefined ||
      meta.titleAttempt !== undefined ||
      (titleOriginOf(meta) !== "manual" && meta.title !== "")
    );
  }

  /** クリアを購読中のタブへ配る。旧メッセージを載せず、新しい履歴世代と空の履歴だけを伝える */
  private emitHistoryCleared(record: SessionRecord, meta: SessionMeta): void {
    const payload = this.payload(record);
    const cleared: SessionPayload = {
      ...payload,
      title: meta.title,
      historyGeneration: meta.historyGeneration ?? "",
      status: "idle",
      lastSeq: record.seq + 1,
      queueDepth: 0,
      pendingSends: [],
      run: null,
      messages: [],
      compactions: [],
    };
    // 旧履歴から作った値は載せない (履歴はクリア後に取り直す)
    delete cleared.assistantMeta;
    delete cleared.context;
    this.emit(record, "resync", cleared);
  }

  /**
   * 会話を分岐する。親の解決済み record を受け取り、この関数の先頭 (最初の await より前) で末尾 entry を
   * 境界として固定する。子は境界までの entry を複製した独立した会話で、以後の追記・要約・マージはしない。
   * 親の meta / 履歴 / 未送信 / タイトル / ピン / 通知は変えない。
   */
  async fork(parent: SessionRecord, { agentId }: { agentId?: string } = {}): Promise<SessionRecord> {
    const storeDir = this.storeDir;
    if (this.storeError) throw httpError(503, `会話ストアを利用できません: ${this.storeError}`);
    if (!storeDir) throw httpError(503, "会話の分岐には会話ストアが必要です");
    const pi = this.pi;
    if (!pi) throw httpError(503, "ランタイムを利用できません");
    if (this.closing) throw httpError(503, "サーバーを終了しています");
    const meta = parent.meta;
    this.assertRecordLive(parent);
    if (meta.handoffCleanup) throw httpError(409, HANDOFF_CLEANUP_PENDING_MESSAGE);
    // busy は引き継ぎと同じ条件。境界より後に受付された送信を子へ含めないため、ここで断る
    if (this.isBusy(parent) || parent.session.isStreaming || parent.changingSettings || parent.stopping) {
      throw httpError(409, "実行中・キュー中・圧縮中・設定変更中のセッションは分岐できません");
    }
    // ここで境界を固定する。送信ルートはスキル展開を await してから postMessage するため、
    // lifecycle を押さえるだけでは境界を保証できない
    const boundaryId = lastEntryId(entriesOf(parent.session));
    const spaceId = meta.spaceId ?? "default";
    // 同じスペースの削除が、書込み中の子と親を見落とさないよう完了まで待たせる (操作単位で登録する)
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const pending: PendingMove = { spaceId, settled };
    this.pendingMoves.add(pending);
    this.lifecycle.set(parent.id, settled);
    try {
      return await this.forkSession(parent, boundaryId, spaceId, { agentId });
    } finally {
      this.pendingMoves.delete(pending);
      if (this.lifecycle.get(parent.id) === settled) this.lifecycle.delete(parent.id);
      settle();
    }
  }

  private async forkSession(
    parent: SessionRecord,
    boundaryId: string | undefined,
    spaceId: string,
    { agentId }: { agentId?: string },
  ): Promise<SessionRecord> {
    const storeDir = this.storeDir as string;
    const meta = parent.meta;
    // 「指定なし」は保存済みのスナップショットを維持する (カタログから消えていても分岐できる)。
    // 「指定あり」は引き継ぎと同じく現在の定義から作り直す
    const resolved = agentId === undefined ? undefined : resolveAgentSkills(this.catalog, agentId);
    const placement = this.placementOf(meta);
    // 共有する作業フォルダが無ければ、空フォルダを作らずに 409 で断る
    await this.requireSharedWorkdir(placement.workdir);
    if (this.forkAborted(parent.id)) throw httpError(404, "Session not found");
    // 破損した原本は writer の全体書直しで上書きされ得るため、必ず persist より前に検証する
    const before = await readSessionFile(storeDir, parent.id);
    if (before.parsed.kind === "damaged") {
      throw httpError(
        409,
        `${new SessionDamagedError(before.parsed.reason).message} (${sessionJsonlPath(parent.id, storeDir)})`,
      );
    }
    // live な親の未保存 entry を確定させる (検証の後。境界まではこの保存で読み直せる)
    const failure = await this.persist(parent);
    await this.flush(parent);
    const saveError = failure ?? parent.persistError ?? parent.writer?.error;
    if (saveError) throw httpError(500, `セッションの保存に失敗しました: ${saveError}`);
    if (this.forkAborted(parent.id)) throw httpError(404, "Session not found");
    const after = await readSessionFile(storeDir, parent.id);
    if (after.parsed.kind === "damaged") {
      throw httpError(500, "セッションの保存に失敗しました: 会話の記録を読み直せません");
    }
    const entries = after.parsed.kind === "ok" ? after.parsed.entries : [];
    const copied = copiedEntries(entries, boundaryId);
    if (!copied) {
      throw httpError(500, "セッションの保存に失敗しました: 分岐の境界が記録に見つかりません");
    }

    const childId = generateSessionId(storeDir);
    const now = Date.now();
    // タイトルと履歴の保存値は、上の保存列を待った**後**の最新状態から読む。persist は parent.meta を
    // 別オブジェクトへ差し替え、AI 要約の予約は record.titleAttempt を先に更新するため、先頭で
    // 捕まえた meta から複製すると親が pending でも子が未試行になる (子で二重に要約し直す)
    const current = parent.meta;
    const model = modelLabel(parent.session.model) ?? current.model;
    const thinkingLevel = parent.session.thinkingLevel ?? current.thinkingLevel;
    const attempt = settledTitleAttemptOf(parent.titleAttempt ?? current.titleAttempt);
    const childMeta: SessionMeta = {
      spaceId,
      version: 1,
      id: childId,
      title: parent.title || current.title,
      createdAt: now,
      lastUsedAt: now,
      // 表示件数は子を開いたときに実履歴から補正する (分岐の成否には影響しない)
      messageCount: current.messageCount,
      agentId: resolved?.agentInfo.id ?? current.agentId,
      agent: resolved?.agentInfo ?? current.agent,
      promptSnapshot: resolved?.promptSnapshot ?? current.promptSnapshot,
      ...(current.projectCwd ? { projectCwd: current.projectCwd } : {}),
      ...(current.projectName ? { projectName: current.projectName } : {}),
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      titleOrigin: parent.titleOrigin ?? titleOriginOf(current),
      // 親に試行が無ければ子も未試行 (一度も正常完了していないなら子の最初の完了で 1 回だけ要約され得る)。
      // pending は子だけ interrupted に終端化し、親の meta / titleTask は変えない
      ...(attempt ? { titleAttempt: attempt } : {}),
      ...((parent.titleRequest ?? current.titleRequest)
        ? { titleRequest: (parent.titleRequest ?? current.titleRequest) as string }
        : {}),
      parentSessionId: parent.id,
      forkedAt: now,
      workdirOwner: this.workdirOwnerOf(meta),
      uploadsOwner: this.uploadsOwnerOf(meta),
    };
    // 表示用の実測は派生データ。複製できなくても分岐は成功させる (SDK の記録値へ落ちる)
    this.copyAssistantMetrics(parent.id, childId);
    try {
      await writeSessionDir(storeDir, childId, {
        meta: childMeta,
        header: sessionHeaderOf(childMeta, workspaceAbs(this.rootCwd, placement.workdir)),
        entries: copied,
      });
    } catch (error) {
      this.deleteAssistantMetrics(childId);
      throw httpError(500, `セッションの保存に失敗しました: ${messageFor(error)}`);
    }
    this.descriptors.set(childId, childMeta);
    try {
      const child = await this.resolve(childId);
      if (!child) {
        throw this.closing
          ? httpError(503, "サーバーを終了しています")
          : httpError(409, "分岐先の会話を作成できませんでした");
      }
      return child;
    } catch (error) {
      // 子の load が失敗した / load 中に DELETE された場合も、store だけの半端な子を残さない
      await this.discardFork(childId);
      throw error;
    }
  }

  /** 分岐の途中で親が消えたか (DELETE / close) */
  private forkAborted(parentId: string): boolean {
    return this.moveAborted(parentId);
  }

  /** 分岐の失敗を回収する。SDK セッション・record / descriptor・子ディレクトリ・複製した実測を残さない */
  private async discardFork(id: string): Promise<void> {
    const record = this.records.get(id);
    this.records.delete(id);
    this.descriptors.delete(id);
    record?.session.dispose?.();
    if (record) this.closeSubscribers(record);
    this.deleteAssistantMetrics(id);
    if (this.storeDir) await removeSessionDir(this.storeDir, id).catch(() => {});
  }

  /** 応答の実測を子の session_id へ写す。派生データなので失敗しても分岐を止めない */
  private copyAssistantMetrics(fromId: string, toId: string): void {
    const store = this.assistantMetrics;
    if (!store) return;
    try {
      for (const row of store.loadAssistantMetrics(fromId)) {
        store.recordAssistantMetrics({ ...row, sessionId: toId });
      }
    } catch (error) {
      console.warn(`[u7agent] assistant metrics copy failed: ${this.masker.mask(messageFor(error))}`);
    }
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
    return this.recordWrites.persist(record, { jsonl });
  }

  async flush(record: SessionRecord): Promise<boolean> {
    return this.recordWrites.flush(record);
  }

  async sweep(): Promise<void> {
    if (this.sweeping || this.closing) return;
    this.sweeping = true;
    try {
      const cutoff = Date.now() - SESSION_TTL_MS;
      // 破棄中に records を変更するため、走査対象は先に固める
      for (const [id, record] of Array.from(this.records)) {
        if (
          this.isBusy(record) ||
          record.titleTask !== undefined ||
          record.subscribers.size > 0 ||
          record.changingSettings
        )
          continue;
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
          // dispose / sweep は会話の削除ではないが、メモリから外した承認を残すと次のロードで効き続ける
          this.networkAccess.revoke(id);
          this.networkAccess.clearDenials(id);
          this.inputGenerations.delete(id);
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
      this.networkAccess.revoke(record.id);
      // 進行中のタイトル要約も外部呼び出しを止める (結果は次の起動へ持ち越さない)
      this.titleProgress.cancel(record);
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
      const messages = displayableMessages(session, workspaceAbs(this.rootCwd, record.workdir));
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
      // タイトルの AI 要約は補助呼び出しで、本文の完了・保存・次の送信を待たせない
      void this.titleProgress.summarize(record, run, bridge.settledAssistantText()).catch(() => {});

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
      // 承認カードを出さない呼び出し (拒否済み・接続先不明など) は、ライブでも質問を投影しない
      hidesQuestions: (toolName, args) =>
        toolName === REQUEST_NETWORK_ACCESS_TOOL_NAME && !this.showsNetworkAccessCard(record.id, args),
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
      onAssistantMetrics: (message, assistantId, metrics) => {
        this.queueAssistantMetrics(record, assistantId, message, metrics);
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
    // resync / 再購読の直前の保留配信を止めるため、run から controller を引けるようにする
    run.cancelThinking = bridge.cancelPendingThinking;
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

  manualSummarizeTitle(record: SessionRecord): Promise<{ title: string; titleSummary: SessionTitleSummary }> {
    return this.titleProgress.summarizeManually(record);
  }

  /** 未開始 / 進行中の AI 要約を取り消す (設定を Off にしたとき)。予約済みの試行は残す */
  cancelTitleSummaries(): void {
    this.titleProgress.cancelAll(this.records.values());
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
