/**
 * 不具合の切り分け用の診断情報。クライアント側でしか取れない値 (SSE の受信列と reducer の状態) を
 * 1 つの JSON にまとめ、サーバーのダンプ (GET /api/sessions/:id/diagnostics) と突き合わせられる形にする。
 *
 * 本文 (メッセージ / 質問 / 回答) は入れず、件数と長さに落とす。貼り付け先では画面の文脈が失われるため、
 * JSON 自身に種別と注意を書く (docs/diagnostics.md)。
 */
import type { ChatState } from "../hooks/chatReducer";
import type { Bubble, ChatHistoryState, ToolCard } from "./chatTypes";
import { startArchiveDownload } from "./archive";
import type { ConfirmRequest } from "./confirmDialog";
import type {
  EventEntry,
  RunErrorCode,
  RunRetryState,
  RunStatus,
  SessionDiagnostics,
  SSEEventType,
  ToolCall,
} from "../types";

export const DIAGNOSTICS_KIND = "u7agent-diagnostics";
export const DIAGNOSTICS_VERSION = 1;

/** クライアントが保持するイベントの上限。超えたら古い方から落とし、落とした件数を残す */
export const CLIENT_EVENT_LIMIT = 200;

export const DIAGNOSTICS_NOTE =
  "本文（メッセージ・質問 / 回答）は含みません。件数・状態・イベントの要約だけを持ちます。";

export const DIAGNOSTICS_TITLE = "セッション診断";
export const DIAGNOSTICS_DESCRIPTION =
  "不具合の切り分け用に、会話の状態を 1 つの JSON にまとめて取り出せます。本文（メッセージ・質問 / 回答）は含みません。";
export const DIAGNOSTICS_FETCH_FAILED = "診断情報を取得できませんでした";
export const DIAGNOSTICS_CLIENT_MISSING = "取得できません（このタブで開いていない会話です）";
export const DIAGNOSTICS_CLIENT_OPEN_BADGE = "このタブで開いています";
export const DIAGNOSTICS_COPY_LABEL = "診断情報をコピー";

export const RAW_LOG_LABEL = "生ログをダウンロード";
export const RAW_LOG_NOTICE =
  "会話の記録ファイル（session.jsonl）をそのまま保存します。画面や履歴へ渡す前にマスクしている値も生のまま含まれます。共有する前に中身を確認してください。";
export const RAW_LOG_MISSING = "この会話の記録は保存されていないため、生ログは取れません。";

/** 生ログの確認。開示のリスクは伝えるが、壊す操作ではないので danger トーンにしない */
export function rawLogConfirmRequest(title: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: RAW_LOG_LABEL,
    ...(title ? { subject: { label: "対象の会話", value: title } } : {}),
    body: [RAW_LOG_NOTICE],
    confirmLabel: "ダウンロードする",
  };
}

/** 1 件のイベントの要約。本文は入れず、長さと件数だけを残す */
export function summarizeEvent(entry: EventEntry): Record<string, unknown> {
  switch (entry.type) {
    case "run_start":
      return {
        runId: entry.data.runId,
        promptChars: entry.data.prompt.length,
        startedAt: entry.data.startedAt,
      };
    case "text":
      return { chars: entry.data.delta.length };
    case "tool_start":
      return {
        id: entry.data.id,
        name: entry.data.name,
        argsChars: entry.data.args.length,
        questions: entry.data.questions?.length ?? 0,
        ...(entry.data.skill ? { skill: entry.data.skill.name } : {}),
      };
    case "tool_end":
      return {
        id: entry.data.id,
        ...(entry.data.name ? { name: entry.data.name } : {}),
        isError: entry.data.isError,
        outputChars: entry.data.output.length,
        answers: entry.data.answers?.length ?? 0,
        skipped: entry.data.answers?.filter((answer) => answer.skipped === true).length ?? 0,
      };
    case "tool_progress":
      return { id: entry.data.id, chars: entry.data.text.length };
    case "status":
      return { state: entry.data.state, text: entry.data.text };
    case "queued":
      return {
        position: entry.data.position,
        queueDepth: entry.data.queueDepth,
        promptChars: entry.data.prompt.length,
      };
    case "queue_cleared":
      return { runIds: entry.data.runIds ?? [] };
    case "usage":
      return { hasUsage: entry.data.usage !== undefined, hasContext: entry.data.context !== undefined };
    case "run_end":
      return {
        runId: entry.data.runId ?? null,
        status: entry.data.status,
        queueDepth: entry.data.queueDepth,
        durationMs: entry.data.durationMs ?? null,
        errorCode: entry.data.errorCode ?? null,
        messageCount: entry.data.messageCount ?? null,
        totalRetryCount: entry.data.totalRetryCount ?? null,
      };
    case "run_retry":
      return {
        retry: entry.data.retry === null ? null : { phase: entry.data.retry.phase, attempt: entry.data.retry.attempt },
        totalRetryCount: entry.data.totalRetryCount,
      };
    case "compaction":
      return { id: entry.data.compaction.id, count: entry.data.count, reason: entry.data.compaction.reason ?? null };
    case "resync":
      return {
        sessionId: entry.data.sessionId,
        status: entry.data.status,
        lastSeq: entry.data.lastSeq,
        runId: entry.data.run?.id ?? null,
        queueDepth: entry.data.queueDepth,
      };
    case "session_deleted":
      return { sessionId: entry.data.sessionId };
  }
}

/** 受信した 1 イベント (古い→新しい)。`at` はサーバーの発行時刻、`receivedAt` はこのタブの受信時刻 */
export type DiagnosticsEventRecord = {
  seq: number;
  type: SSEEventType;
  at: number;
  receivedAt: number;
  fields: Record<string, unknown>;
};

export type DiagnosticsCursor = { generation: string; seq: number };

export type DiagnosticsRecorderState = {
  sessionId: string;
  events: DiagnosticsEventRecord[];
  /** 上限で落とした件数 */
  dropped: number;
  /** 再接続を試みた回数 (セッション切替で 0 に戻る) */
  reconnectCount: number;
  lastCursor: DiagnosticsCursor | null;
  lastReceivedAt: number | null;
};

export type DiagnosticsRecorder = {
  /** 対象セッションを切り替える。変わったら保持分 (イベント / 再接続回数 / カーソル) を捨てる */
  beginSession(sessionId: string): void;
  /**
   * payload (初期取得 / resync / 回復) の適用時に、対象セッションを合わせてカーソルを seed する。
   * SSE が 1 件も届いていない間でも相関キー (世代 / seq) を埋め、セッション切替では保持分を捨てる。
   */
  seedCursor(sessionId: string, generation: string, seq: number): void;
  /**
   * SSE の世代を合わせる。再起動 / sweep で世代が変わったら seq は新しい世代のものへ戻す
   * (旧世代の seq を残すと、実在しないカーソルを診断が報告する)。
   */
  setGeneration(generation: string): void;
  /**
   * 受信イベントの記録。`sourceSessionId` は接続元のセッションで、対象と違えば捨てる
   * (切替直後に旧接続から届いたイベントを新しい会話へ混ぜない)。
   */
  record(entry: EventEntry, sourceSessionId: string, receivedAt?: number): void;
  /** 再接続を試みた (無音の検知 / 切断からの復帰) */
  recordReconnect(): void;
  capture(): DiagnosticsRecorderState;
};

export function createDiagnosticsRecorder(): DiagnosticsRecorder {
  let sessionId = "";
  let events: DiagnosticsEventRecord[] = [];
  let dropped = 0;
  let reconnectCount = 0;
  let generation = "";
  let lastCursor: DiagnosticsCursor | null = null;
  let lastReceivedAt: number | null = null;

  const clear = (): void => {
    events = [];
    dropped = 0;
    reconnectCount = 0;
    generation = "";
    lastCursor = null;
    lastReceivedAt = null;
  };

  const track = (next: string): boolean => {
    if (next === sessionId) return false;
    sessionId = next;
    clear();
    return true;
  };

  return {
    beginSession(next): void {
      track(next);
    },
    seedCursor(next, nextGeneration, seq): void {
      track(next);
      generation = nextGeneration;
      // payload の lastSeq がその時点のサーバー位置。イベント前でも相関キーが埋まる
      lastCursor = nextGeneration === "" ? null : { generation: nextGeneration, seq };
    },
    setGeneration(next): void {
      if (next !== generation) lastCursor = next === "" ? null : { generation: next, seq: 0 };
      generation = next;
    },
    record(entry, sourceSessionId, receivedAt = Date.now()): void {
      if (sourceSessionId !== sessionId) return;
      events.push({
        seq: entry.seq,
        type: entry.type,
        at: entry.at,
        receivedAt,
        fields: summarizeEvent(entry),
      });
      if (events.length > CLIENT_EVENT_LIMIT) {
        const overflow = events.length - CLIENT_EVENT_LIMIT;
        events = events.slice(overflow);
        dropped += overflow;
      }
      lastReceivedAt = receivedAt;
      // カーソルの世代は常に generation と一致する (seed / setGeneration / ここだけが書き手)。
      // payload で seed 済みの位置を巻き戻さないよう、seq は最大値を保つ
      const seq = Number.isFinite(entry.seq) ? entry.seq : (lastCursor?.seq ?? 0);
      lastCursor = generation === "" ? null : { generation, seq: Math.max(seq, lastCursor?.seq ?? seq) };
    },
    recordReconnect(): void {
      reconnectCount += 1;
    },
    capture(): DiagnosticsRecorderState {
      return {
        sessionId,
        events: [...events],
        dropped,
        reconnectCount,
        lastCursor: lastCursor === null ? null : { ...lastCursor },
        lastReceivedAt,
      };
    },
  };
}

/** カード / 結果行に出す 1 枚のカード。`answers` の有無と `skipped` の数だけを持ち、本文は入れない */
export type ToolCardSnapshot = {
  id: string;
  name: string;
  phase: ToolCard["phase"];
  questionCount: number;
  answerCount: number;
  hasAnswers: boolean;
  skippedCount: number;
};

export function toolCardSnapshotOf(card: ToolCard): ToolCardSnapshot {
  const answers = card.answers ?? [];
  return {
    id: card.id,
    name: card.name,
    phase: card.phase,
    questionCount: card.questions?.length ?? 0,
    answerCount: answers.length,
    hasAnswers: card.answers !== undefined,
    skippedCount: answers.filter((answer) => answer.skipped === true).length,
  };
}

function bubbleToolsOf(bubbles: readonly Bubble[]): { bubbleId: number; tools: ToolCardSnapshot[] }[] {
  return bubbles
    .filter((bubble) => bubble.tools.length > 0)
    .map((bubble) => ({ bubbleId: bubble.id, tools: bubble.tools.map(toolCardSnapshotOf) }));
}

/** ライブの runTools (reducer の ToolCall) を、バブル側と同じ形に落とす */
function runToolSnapshotOf(card: ToolCall): ToolCardSnapshot {
  const answers = card.answers ?? [];
  return {
    id: card.id,
    name: card.name,
    phase: card.done ? (card.isError ? "failed" : "done") : "running",
    questionCount: card.questions?.length ?? 0,
    answerCount: answers.length,
    hasAnswers: card.answers !== undefined,
    skippedCount: answers.filter((answer) => answer.skipped === true).length,
  };
}

/** history の状態。ページ本文は入れない (キーと現在値だけ) */
export type HistorySnapshot = Pick<
  ChatHistoryState,
  | "supported"
  | "hasMore"
  | "loading"
  | "messageCount"
  | "summarizedMessageCount"
  | "activeContextStartId"
  | "nextCursor"
> & { hasGap: boolean; pendingPage: boolean };

export type ClientSnapshot = {
  sessionId: string;
  runStatus: RunStatus;
  queueDepth: number;
  runStartedAt: number | null;
  activity: string;
  activityState: string | null;
  currentAssistantId: number | null;
  liveToolIds: string[];
  pendingEchoIds: number[];
  clearedRunIds: string[];
  retry: RunRetryState | null;
  runError: { code: RunErrorCode; text: string } | null;
  bubbles: { count: number; lastRole: Bubble["role"] | null };
  /** ライブの run のカード (reducer の runTools) */
  runTools: ToolCardSnapshot[];
  /** 履歴バブル側のカード。runTools と 2 系統あることを見えるようにする */
  bubbleTools: { bubbleId: number; tools: ToolCardSnapshot[] }[];
  history: HistorySnapshot;
  events: {
    limit: number;
    available: number;
    dropped: number;
    reconnectCount: number;
    lastCursor: DiagnosticsCursor | null;
    lastReceivedAt: number | null;
    items: DiagnosticsEventRecord[];
  };
};

export function clientSnapshotOf(chat: ChatState, recorder: DiagnosticsRecorderState): ClientSnapshot {
  return {
    sessionId: chat.sessionId,
    runStatus: chat.runStatus,
    queueDepth: chat.queueDepth,
    runStartedAt: chat.runStartedAt ?? null,
    activity: chat.activity,
    activityState: chat.activityState ?? null,
    currentAssistantId: chat.currentAssistantId,
    liveToolIds: [...chat.liveToolIds],
    pendingEchoIds: [...chat.pendingEchoIds],
    clearedRunIds: [...chat.clearedRunIds],
    retry: chat.retry ?? null,
    runError: chat.runError ? { code: chat.runError.code, text: chat.runError.text } : null,
    bubbles: {
      count: chat.bubbles.length,
      lastRole: chat.bubbles.at(-1)?.role ?? null,
    },
    runTools: Object.values(chat.runTools).map(runToolSnapshotOf),
    bubbleTools: bubbleToolsOf(chat.bubbles),
    history: {
      supported: chat.history.supported,
      hasMore: chat.history.hasMore,
      loading: chat.history.loading,
      messageCount: chat.history.messageCount,
      summarizedMessageCount: chat.history.summarizedMessageCount,
      activeContextStartId: chat.history.activeContextStartId,
      nextCursor: chat.history.nextCursor,
      hasGap: chat.history.gapCursor !== null,
      pendingPage: chat.history.pendingPage !== null,
    },
    events: {
      limit: CLIENT_EVENT_LIMIT,
      available: recorder.events.length,
      dropped: recorder.dropped,
      reconnectCount: recorder.reconnectCount,
      lastCursor: recorder.lastCursor,
      lastReceivedAt: recorder.lastReceivedAt,
      items: recorder.events,
    },
  };
}

export type DiagnosticsReport = {
  kind: typeof DIAGNOSTICS_KIND;
  version: typeof DIAGNOSTICS_VERSION;
  note: string;
  capturedAt: number;
  sessionId: string;
  /** このタブで開いている会話。sessionId と違えばクライアント状態は付かない */
  openSessionId: string;
  /** クライアントのビルド識別子 */
  clientBuild: string;
  eventGeneration: string | null;
  lastSeq: number | null;
  reconnectCount: number;
  client: ClientSnapshot | null;
  clientUnavailable: "not-open" | "unavailable" | null;
  server: SessionDiagnostics | null;
  serverError: string | null;
  drops: {
    /** クライアントのリングバッファが上限で落とした件数 */
    client: number;
    /** サーバーが上限 (件数 / バイト) で落とした件数 */
    server: number;
    /** サーバーが 1 イベントの `data` を切り詰めた件数 */
    serverTruncated: number;
  };
};

/**
 * クライアントとサーバーの 1 回ぶんのスナップショットを 1 つの JSON にまとめる。
 * どちらかが取れなくても、取れた方だけで作る (失敗の理由は `serverError` / `clientUnavailable` に残す)。
 */
export function buildDiagnosticsReport({
  sessionId,
  openSessionId,
  chat,
  recorder,
  server,
  serverError = null,
  clientBuild,
  capturedAt = Date.now(),
}: {
  sessionId: string;
  openSessionId: string;
  chat: ChatState;
  recorder: DiagnosticsRecorderState;
  server: SessionDiagnostics | null;
  serverError?: string | null;
  clientBuild: string;
  capturedAt?: number;
}): DiagnosticsReport {
  const isOpen = sessionId !== "" && sessionId === openSessionId;
  // 記録が対象セッションのものか。他会話の観測値 (カーソル / 省略 / 再接続) は相関キーへ持ち込まない
  const ownsRecorder = recorder.sessionId === sessionId;
  const client = isOpen && ownsRecorder ? clientSnapshotOf(chat, recorder) : null;
  const cursor = ownsRecorder ? recorder.lastCursor : null;
  return {
    kind: DIAGNOSTICS_KIND,
    version: DIAGNOSTICS_VERSION,
    note: DIAGNOSTICS_NOTE,
    capturedAt,
    sessionId,
    openSessionId,
    clientBuild,
    // 対象の client 記録が無いときは、対象 server の相関キーを使う (他会話の値は使わない)
    eventGeneration: cursor?.generation ?? server?.eventGeneration ?? null,
    lastSeq: cursor?.seq ?? server?.lastSeq ?? null,
    reconnectCount: ownsRecorder ? recorder.reconnectCount : 0,
    client,
    clientUnavailable: client !== null ? null : isOpen ? "unavailable" : "not-open",
    server,
    serverError,
    drops: {
      client: ownsRecorder ? recorder.dropped : 0,
      server: server?.events.dropped ?? 0,
      serverTruncated: server?.events.truncated ?? 0,
    },
  };
}

export function diagnosticsFileName(sessionId: string, at: number): string {
  return `u7agent-diagnostics-${fileStamp(sessionId, at)}.json`;
}

export function rawLogFileName(sessionId: string, at: number): string {
  return `u7agent-raw-${fileStamp(sessionId, at)}.jsonl`;
}

/** 保存名の `<id8>-<yyyymmdd-hhmm>`。時刻はブラウザーのローカル時間 */
function fileStamp(sessionId: string, at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${sessionId.slice(0, 8)}-${stamp}`;
}

/**
 * 内容をファイルとして保存する。コピーに失敗したときの逃げ道 (文字列) と、生ログ (Blob) で共通。
 * Blob はそのまま渡し、生ログのバイトを再エンコードしない。
 */
export function saveTextFile(content: string | Blob, name: string, type = "application/json"): void {
  const blob = typeof content === "string" ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  try {
    startArchiveDownload(url, name);
  } finally {
    // クリックで保存が始まった後なら revoke してもダウンロードは続く
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** 上限で落ちた / 切り詰めた件数の 1 行。空文字は「省略なし」(結果行と省略の報告で同じ文言を使う) */
export function diagnosticsDropsLine(report: DiagnosticsReport): string {
  const { client, server, serverTruncated } = report.drops;
  if (client === 0 && server === 0 && serverTruncated === 0) return "";
  const parts = [`省略: サーバー ${server} 件 / クライアント ${client} 件`];
  if (serverTruncated > 0) parts.push(`切り詰め: ${serverTruncated} 件`);
  return parts.join(" / ");
}

/** コピー後の結果行。画面でも相関キーと省略の件数を確認できるようにする */
export function diagnosticsResultLine(report: DiagnosticsReport): string {
  const time = new Date(report.capturedAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  const generation = report.eventGeneration ?? "不明";
  const seq = report.lastSeq ?? "不明";
  const drops = diagnosticsDropsLine(report);
  return `${stamp} / seq ${seq} / generation ${generation} / 再接続 ${report.reconnectCount} 回${drops === "" ? "" : ` / ${drops}`}`;
}

/**
 * サーバーとクライアントの値を並べる行。どちらが正しいかは判定しない (クライアントが 1 イベント
 * 遅れるのは正常で、不一致の強調は誤診を招くため)。
 */
export type DiagnosticsCompareRow = { label: string; server: string; client: string };

function text(value: unknown): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

export function diagnosticsCompareRows(
  server: SessionDiagnostics | null,
  client: ClientSnapshot | null,
): DiagnosticsCompareRow[] {
  return [
    { label: "状態", server: text(server?.status), client: text(client?.runStatus) },
    { label: "キュー深度", server: text(server?.queue.depth), client: text(client?.queueDepth) },
    { label: "実行中の run id", server: text(server?.run?.id), client: "—" },
    { label: "最終 seq", server: text(server?.lastSeq), client: text(client?.events.lastCursor?.seq) },
    { label: "世代", server: text(server?.eventGeneration), client: text(client?.events.lastCursor?.generation) },
    { label: "イベント保持", server: text(server?.events.available), client: text(client?.events.available) },
    { label: "省略（イベント）", server: text(server?.events.dropped), client: text(client?.events.dropped) },
    { label: "切り詰め（data）", server: text(server?.events.truncated), client: "—" },
    { label: "再接続", server: "—", client: text(client?.events.reconnectCount) },
  ];
}
