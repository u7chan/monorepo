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
    const clipped = clipEventData(entry.data);
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
export type DiagnosticsInput = {
  sessionId: string;
  /** SSE の世代。未ロードの会話は空文字 (live な record が無い) */
  generation: string;
  seq: number;
  events: readonly EventEntry[];
  status: RunStatus;
  queueRunIds: readonly string[];
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
  meta: {
    spaceId: string;
    title: string;
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
 * 診断ダンプの投影。マスクは渡された生値へ掛ける (`payload` と同じ規約で、タイトルとエラー文言が対象)。
 * イベントの `data` は emit 時点でマスク済みのため、そのまま載せる。
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
      title: masker.mask(meta.title),
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
    queue: { depth: input.queueRunIds.length, runIds: [...input.queueRunIds] },
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
    events: {
      limit: DIAGNOSTICS_EVENT_LIMIT,
      maxBytes: DIAGNOSTICS_RESPONSE_MAX_BYTES,
      ...collectDiagnosticsEvents(input.events),
    },
    raw: input.raw,
  };
}
