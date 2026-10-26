/**
 * セッション診断 (`GET /api/sessions/:id/diagnostics`) の投影。SessionRecord を読み取り専用の入力とし、
 * mask 済みのイベント列を上限へ収める計算だけを持つ (HTTP は routes/sessions.ts、契約は schema.ts)。
 *
 * 上限は件数とバイトの 2 段。どちらも落とした件数を応答に残し、無言の切り詰めをしない
 * (何が欠けたか分からないダンプは切り分けの役に立たない)。
 */
import type { SecretMasker } from "./redact";
import type {
  DiagnosticsEvent,
  EventEntry,
  RunErrorCode,
  RunRetryState,
  RunStatus,
  SessionDiagnostics,
  SSEEventData,
  SSEEventType,
} from "./schema";

/** 返すイベントの件数上限 */
export const DIAGNOSTICS_EVENT_LIMIT = 500;
/** 応答全体のバイト上限。超えたら古い方から落とす */
export const DIAGNOSTICS_RESPONSE_MAX_BYTES = 512 * 1024;
/** 1 イベントの `data` のバイト上限 */
export const DIAGNOSTICS_EVENT_DATA_MAX_BYTES = 8 * 1024;
/** 1 つの文字列の上限。tool の出力など 1 フィールドが長い場合をここで削る */
export const DIAGNOSTICS_STRING_MAX = 1024;
/** 1 つの配列の上限。resync の messages など、件数で膨らむ場合をここで削る */
const DIAGNOSTICS_ARRAY_MAX = 50;
/** 入れ子の深さ上限 (環状参照や異常な深さで再帰を止める) */
const DIAGNOSTICS_DEPTH_MAX = 12;

function bytesOf(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
}

interface Clipped {
  value: unknown;
  /** 値の一部を落とした (または置き換えた) */
  clipped: boolean;
}

function clipValue(value: unknown, depth: number): Clipped {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= DIAGNOSTICS_STRING_MAX) return { value, clipped: false };
    return { value: `${value.slice(0, DIAGNOSTICS_STRING_MAX)}…`, clipped: true };
  }
  if (Array.isArray(value)) {
    const keep = value.slice(0, DIAGNOSTICS_ARRAY_MAX).map((item) => clipValue(item, depth + 1));
    return {
      value: keep.map((item) => item.value),
      clipped: keep.some((item) => item.clipped) || value.length > DIAGNOSTICS_ARRAY_MAX,
    };
  }
  if (value !== null && typeof value === "object" && depth < DIAGNOSTICS_DEPTH_MAX) {
    let clipped = false;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const result = clipValue(item, depth + 1);
      clipped ||= result.clipped;
      return [key, result.value] as const;
    });
    return { value: Object.fromEntries(entries), clipped };
  }
  if (depth >= DIAGNOSTICS_DEPTH_MAX) return { value: "[depth]", clipped: true };
  return { value, clipped: false };
}

type DataOf<T extends SSEEventType> = SSEEventData[T];

/**
 * イベントの `data` を診断用の要約へ落とす。SSE の mask 規則 (`emit` 時点の `[REDACTED]`) は変えず、
 * 本文 (プロンプト / 差分テキスト / 質問 / 回答 / ツール出力 / 進捗 / 圧縮の要約 / resync の messages と
 * pendingSends の本文) を件数と文字数へ置き換える。診断 JSON が本文を含まない契約の実装点。
 */
export function summarizeEventData<T extends SSEEventType>(type: T, data: DataOf<T>): unknown {
  switch (type) {
    case "run_start": {
      const value = data as DataOf<"run_start">;
      return { runId: value.runId, promptChars: value.prompt.length, startedAt: value.startedAt };
    }
    case "text":
      return { chars: (data as DataOf<"text">).delta.length };
    case "tool_start": {
      const value = data as DataOf<"tool_start">;
      return {
        id: value.id,
        name: value.name,
        argsChars: value.args.length,
        questions: value.questions?.length ?? 0,
        ...(value.startedAt !== undefined ? { startedAt: value.startedAt } : {}),
        ...(value.skill ? { skill: { id: value.skill.id, name: value.skill.name } } : {}),
      };
    }
    case "tool_end": {
      const value = data as DataOf<"tool_end">;
      return {
        id: value.id,
        ...(value.name ? { name: value.name } : {}),
        isError: value.isError,
        outputChars: value.output.length,
        answers: value.answers?.length ?? 0,
        skipped: value.answers?.filter((answer) => answer.skipped === true).length ?? 0,
        ...(value.endedAt !== undefined ? { endedAt: value.endedAt } : {}),
      };
    }
    case "tool_progress":
      // 子エージェントの本文末尾が入るため、長さだけを残す
      return { id: (data as DataOf<"tool_progress">).id, chars: (data as DataOf<"tool_progress">).text.length };
    case "queued": {
      const value = data as DataOf<"queued">;
      return { position: value.position, queueDepth: value.queueDepth, promptChars: value.prompt.length };
    }
    case "compaction": {
      const value = data as DataOf<"compaction">;
      const { compaction } = value;
      return {
        count: value.count,
        id: compaction.id,
        summaryChars: compaction.summary.length,
        ...(compaction.reason ? { reason: compaction.reason } : {}),
        ...(compaction.tokensBefore !== undefined ? { tokensBefore: compaction.tokensBefore } : {}),
        ...(compaction.estimatedTokensAfter !== undefined
          ? { estimatedTokensAfter: compaction.estimatedTokensAfter }
          : {}),
        ...(compaction.durationMs !== undefined ? { durationMs: compaction.durationMs } : {}),
      };
    }
    case "resync": {
      const value = data as DataOf<"resync">;
      return {
        sessionId: value.sessionId,
        status: value.status,
        lastSeq: value.lastSeq,
        eventGeneration: value.eventGeneration,
        queueDepth: value.queueDepth,
        messageCount: value.messages.length,
        run: value.run
          ? {
              id: value.run.id,
              status: value.run.status,
              totalRetryCount: value.run.totalRetryCount,
              toolCalls: value.run.toolCalls.length,
            }
          : null,
        pendingSends: value.pendingSends?.length ?? 0,
        compactions: value.compactions.length,
      };
    }
    default:
      // status / queue_cleared / usage / assistant_end / run_end / run_retry / session_deleted は本文を含まない
      return data;
  }
}

/** 1 イベントの `data` を上限へ収める。文字列を切っても超えるなら、値を捨てて元のバイト数だけ残す */
function clipEventData(data: unknown): Clipped {
  const clipped = clipValue(data, 0);
  if (bytesOf(clipped.value) <= DIAGNOSTICS_EVENT_DATA_MAX_BYTES) return clipped;
  return { value: { truncated: true, bytes: bytesOf(data) }, clipped: true };
}

/** `u7agent-raw-<id8>-<yyyymmdd-hhmm>.jsonl`。保存名はクライアントと揃える (タイムゾーンはサーバー側) */
export function rawLogFileName(id: string, at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `u7agent-raw-${id.slice(0, 8)}-${stamp}.jsonl`;
}

/**
 * 直近のイベント列を上限へ収めて古い→新しい順で返す。`available` はリングバッファの件数で、
 * `dropped` は件数とバイトの上限で落とした合計 (利用者が「どこまで遡れるか」を判断できるようにする)。
 */
export function collectDiagnosticsEvents(events: readonly EventEntry[]): {
  available: number;
  items: DiagnosticsEvent[];
  dropped: number;
  truncated: number;
} {
  const available = events.length;
  const target = events.slice(-DIAGNOSTICS_EVENT_LIMIT);
  const items: DiagnosticsEvent[] = [];
  let dropped = available - target.length;
  let truncated = 0;
  let total = 0;
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const entry = target[index];
    // 元のバイト数は切り詰め前の値として残す (何がどれだけ膨らんでいたかを見る)
    const clipped = clipEventData(summarizeEventData(entry.type, entry.data));
    const item: DiagnosticsEvent = {
      seq: entry.seq,
      type: entry.type,
      at: entry.at,
      bytes: bytesOf(entry.data),
      data: clipped.value,
      ...(clipped.clipped ? { truncated: true } : {}),
    };
    const size = bytesOf(item);
    // 予算を超える分は古い方から落とす。1 件目の超過でも返す (空のダンプにはしない)
    if (items.length > 0 && total + size > DIAGNOSTICS_RESPONSE_MAX_BYTES) {
      dropped += index + 1;
      break;
    }
    total += size;
    if (clipped.clipped) truncated += 1;
    items.unshift(item);
  }
  return { available, items, dropped, truncated };
}

/** 投影へ渡す、記録の出所に依存しない値。live な record と保存済み descriptor のどちらからも組める */
export type DiagnosticsTitleAttempt = {
  runId: string;
  at: number;
  state: "pending" | "done" | "failed" | "skipped";
  model?: string;
  thinkingLevel?: string;
  generation?: number;
  inputTokens?: number;
  outputTokens?: number;
  costTotal?: number;
};

export type DiagnosticsInput = {
  sessionId: string;
  /** SSE の世代。未ロードの会話は空文字 (live な record が無い) */
  generation: string;
  seq: number;
  events: readonly EventEntry[];
  status: RunStatus;
  queueSendIds: readonly string[];
  run: {
    id: string;
    status: RunStatus;
    startedAt: number;
    endedAt?: number;
    totalRetryCount: number;
    retry?: RunRetryState;
    errorCode?: RunErrorCode;
    error?: string;
  } | null;
  questions: readonly { toolCallId: string; questionCount: number; settled: boolean }[];
  /** タイトルの由来と AI 要約の試行。本文・生成タイトルは持たない (試行状態と usage だけ) */
  title?: { origin: "auto" | "ai" | "manual"; attempt?: DiagnosticsTitleAttempt };
  meta: {
    spaceId: string;
    agentId: string;
    agentName: string;
    projectId?: string;
    projectName?: string;
    workdir: string;
    createdAt: number;
    lastUsedAt: number;
    messageCount: number;
    model?: string;
    thinkingLevel?: string;
    notify: boolean;
    pinned: boolean;
    persistError?: string;
    sendsError?: string;
    sendsDirty: boolean;
  };
  raw: { available: boolean; bytes?: number };
};

/**
 * 診断ダンプの投影。マスクは渡された生値へ掛ける (`payload` と同じ規約で、エージェント名とエラー文言が
 * 対象)。イベントの `data` は emit 時点でマスク済み + `summarizeEventData` の要約を通し、タイトルは
 * 本文の先頭を含み得るため載せない (診断 JSON が本文を含まない契約の一部)。
 */
export function projectSessionDiagnostics({
  input,
  masker,
  now = Date.now(),
}: {
  input: DiagnosticsInput;
  masker: SecretMasker;
  now?: number;
}): SessionDiagnostics {
  const { meta, run } = input;
  return {
    kind: "u7agent-session-diagnostics",
    version: 1,
    sessionId: input.sessionId,
    capturedAt: now,
    eventGeneration: input.generation,
    lastSeq: input.seq,
    status: input.status,
    meta: {
      spaceId: meta.spaceId,
      agentId: meta.agentId,
      agentName: masker.mask(meta.agentName),
      ...(meta.projectId ? { projectId: meta.projectId } : {}),
      ...(meta.projectName ? { projectName: masker.mask(meta.projectName) } : {}),
      workdir: meta.workdir,
      createdAt: meta.createdAt,
      lastUsedAt: meta.lastUsedAt,
      messageCount: meta.messageCount,
      ...(meta.model ? { model: masker.mask(meta.model) } : {}),
      ...(meta.thinkingLevel ? { thinkingLevel: meta.thinkingLevel } : {}),
      notify: meta.notify,
      pinned: meta.pinned,
      ...(meta.persistError ? { persistError: masker.mask(meta.persistError) } : {}),
      ...(meta.sendsError ? { sendsError: masker.mask(meta.sendsError) } : {}),
      sendsDirty: meta.sendsDirty,
    },
    queue: { depth: input.queueSendIds.length, sendIds: [...input.queueSendIds] },
    run: run
      ? {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
          ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
          totalRetryCount: run.totalRetryCount,
          ...(run.retry ? { retry: { ...run.retry } } : {}),
          ...(run.errorCode ? { errorCode: run.errorCode } : {}),
          ...(run.error ? { error: masker.mask(run.error) } : {}),
        }
      : null,
    questions: input.questions.map((question) => ({ ...question })),
    ...(input.title
      ? {
          title: {
            origin: input.title.origin,
            ...(input.title.attempt ? { attempt: { ...input.title.attempt } } : {}),
          },
        }
      : {}),
    events: {
      limit: DIAGNOSTICS_EVENT_LIMIT,
      maxBytes: DIAGNOSTICS_RESPONSE_MAX_BYTES,
      ...collectDiagnosticsEvents(input.events),
    },
    raw: input.raw,
  };
}
