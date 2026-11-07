/**
 * 実行中ランの thinking 末尾 (live 専用)。SSE の `status` にだけ載せ、payload / JSONL / DB へは保存しない。
 * 秘密値の境界は本文用の masker と共有せず、thinking ブロックごとに作り直す。
 */
import { createStreamingSecretMasker, type SecretMasker, type StreamingSecretMasker } from "./redact";
import type { EventEntry } from "./schema";

/** `status.thinking` に載せる末尾の上限 (code point)。 */
export const LIVE_THINKING_MAX_CHARS = 1200;
/** 末尾を `status` へ載せる最短間隔。phase の変化は間引かない。 */
export const LIVE_THINKING_THROTTLE_MS = 500;

/** code point 単位で末尾を残す (サロゲートペアを割らない)。 */
export function tailText(text: string, maxChars: number = LIVE_THINKING_MAX_CHARS): string {
  if (maxChars <= 0) return "";
  // 上限以下は数えない (長い本文でも毎回すべての code point を作らない)
  if (text.length <= maxChars) return text;
  const points = Array.from(text);
  return points.length <= maxChars ? text : points.slice(points.length - maxChars).join("");
}

export interface LiveThinkingDeps {
  /** 送出層の masker。ブロックごとに `createStreamingSecretMasker` で包む */
  masker: SecretMasker;
  /** 末尾を配る (空文字は渡さない)。phase の status は呼び出し側が持つ */
  emit: (thinking: string) => void;
  now?: () => number;
  throttleMs?: number;
  maxChars?: number;
  /** 遅延配信の予約。戻り値を呼ぶと取り消す (テストは実タイマーを使わない) */
  schedule?: (deliver: () => void, delayMs: number) => () => void;
}

export interface LiveThinking {
  /** thinking の delta。mask した末尾を保持し、間隔を空けて配る */
  push(delta: string): void;
  /**
   * thinking ブロックの終了 (次の明示的な境界)。保留中の末尾は公開せず破棄し、masker の失敗も解く
   */
  clear(): void;
  /**
   * 保留中の配信だけを取り消す (masker の境界バッファと次の delta の受付は維持)。
   * masker が失敗したブロックは解かない (境界が戻るのは次の `clear()` だけ)
   */
  cancelPending(): void;
}

const scheduleWithTimer = (deliver: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(deliver, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export function createLiveThinking(deps: LiveThinkingDeps): LiveThinking {
  const now = deps.now ?? Date.now;
  const throttleMs = deps.throttleMs ?? LIVE_THINKING_THROTTLE_MS;
  const maxChars = deps.maxChars ?? LIVE_THINKING_MAX_CHARS;
  const schedule = deps.schedule ?? scheduleWithTimer;

  // 値が入っている間が 1 つの thinking ブロック。ブロックごとに masker を作り直す
  let streaming: StreamingSecretMasker | undefined;
  let tail = "";
  let deliveredAt: number | undefined;
  let cancelScheduled: (() => void) | undefined;
  /**
   * masker が失敗したブロック。失敗した streaming masker は保留境界を失っているため、残りを
   * 新しい masker で処理すると分割された秘密値の先頭が平文で出る。次の明示的な境界 (clear) まで
   * このブロックの delta は一切配信しない
   */
  let failed = false;

  const cancelDelivery = (): void => {
    cancelScheduled?.();
    cancelScheduled = undefined;
  };

  const deliver = (): void => {
    cancelScheduled = undefined;
    deliveredAt = now();
    if (tail === "") return;
    try {
      deps.emit(tail);
    } catch {
      // 観測専用。表示の失敗で run を止めない
    }
  };

  const reset = (): void => {
    cancelDelivery();
    streaming = undefined;
    tail = "";
    deliveredAt = undefined;
  };

  return {
    push(delta: string): void {
      if (!delta) return;
      // 失敗したブロックの続きは、境界を失った masker では安全に処理できない
      if (failed) return;
      try {
        if (!streaming) {
          streaming = createStreamingSecretMasker(deps.masker);
          // ブロックの最初の delta は間引かない (phase が変わった直後に出る)
          deliveredAt = undefined;
        }
        tail = tailText(tail + streaming.push(delta), maxChars);
      } catch {
        // masker の失敗では raw を出さず、次の明示的なブロック境界までこのブロックを閉じる
        reset();
        failed = true;
        return;
      }
      if (tail === "") return;
      const at = now();
      const elapsed = deliveredAt === undefined ? throttleMs : at - deliveredAt;
      if (elapsed >= throttleMs) {
        deliver();
        return;
      }
      if (cancelScheduled !== undefined) return;
      cancelScheduled = schedule(deliver, throttleMs - elapsed);
    },
    clear(): void {
      reset();
      // 次のブロックは新しい masker で始める (失敗したブロックを引き継がない)
      failed = false;
    },
    cancelPending(): void {
      cancelDelivery();
    },
  };
}

/** リプレイ用: `status.thinking` を落とす (phase の status はそのまま復元する)。 */
export function withoutThinking(entry: EventEntry): EventEntry {
  if (entry.type !== "status" || entry.data.thinking === undefined) return entry;
  const data = { ...entry.data };
  delete data.thinking;
  return { ...entry, data };
}
