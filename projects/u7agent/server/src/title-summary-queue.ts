/**
 * 会話タイトルの AI 要約の共有実行制御。要約は非同期でもプロバイダーの同時実行枠・
 * レート制限を消費するため、同時に走らせる数を絞り、待ち行列で待たせ、待ち時間の上限を超えたら
 * スキップする。本会話の送信はこのキューを通らない (補助呼び出しが本会話を待たせない)。
 */
export type TitleSummaryQueueSkipReason = "timeout" | "cancelled" | "not_ready";

export type TitleSummaryQueueResult<T> =
  | { kind: "ran"; value: T }
  | { kind: "skipped"; reason: TitleSummaryQueueSkipReason };

export interface TitleSummaryQueueOptions {
  /** 同時に走らせる補助呼び出しの上限 */
  concurrency?: number;
  /** 待ち行列で待てる時間。超えたら実行しない */
  waitTimeoutMs?: number;
}

export interface TitleSummaryQueueEntry {
  /** 取消 (Off への変更・手動改名・停止) */
  signal: AbortSignal;
  /** 順番が来た時点で実行してよいか (会話が実行中なら本会話を優先してスキップする) */
  shouldStart: () => boolean;
}

interface Waiter {
  entry: TitleSummaryQueueEntry;
  settle: (result: "granted" | TitleSummaryQueueSkipReason) => void;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

export class TitleSummaryQueue {
  #limit: number;
  #timeoutMs: number;
  #active = 0;
  #waiters: Waiter[] = [];

  constructor(options: TitleSummaryQueueOptions = {}) {
    this.#limit = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.#timeoutMs = Math.max(0, options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  }

  /** 実行中の補助呼び出し数 (テストと診断用) */
  get active(): number {
    return this.#active;
  }

  /** 待ち行列の件数 (テストと診断用) */
  get waiting(): number {
    return this.#waiters.length;
  }

  async run<T>(entry: TitleSummaryQueueEntry, task: () => Promise<T>): Promise<TitleSummaryQueueResult<T>> {
    const decision = await this.#acquire(entry);
    if (decision !== "granted") return { kind: "skipped", reason: decision };
    try {
      return { kind: "ran", value: await task() };
    } finally {
      this.#release();
    }
  }

  #acquire(entry: TitleSummaryQueueEntry): Promise<"granted" | TitleSummaryQueueSkipReason> {
    if (entry.signal.aborted) return Promise.resolve("cancelled");
    if (!entry.shouldStart()) return Promise.resolve("not_ready");
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve("granted");
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: "granted" | TitleSummaryQueueSkipReason): void => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        entry.signal.removeEventListener("abort", onAbort);
        const index = this.#waiters.findIndex((candidate) => candidate.settle === settle);
        if (index !== -1) this.#waiters.splice(index, 1);
        resolve(result);
      };
      const onAbort = (): void => settle("cancelled");
      timer = setTimeout(() => settle("timeout"), this.#timeoutMs);
      timer.unref?.();
      entry.signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push({ entry, settle });
    });
  }

  #release(): void {
    this.#active = Math.max(0, this.#active - 1);
    while (this.#active < this.#limit) {
      const waiter = this.#waiters[0];
      if (!waiter) return;
      if (waiter.entry.signal.aborted) {
        waiter.settle("cancelled");
        continue;
      }
      if (!waiter.entry.shouldStart()) {
        waiter.settle("not_ready");
        continue;
      }
      this.#active += 1;
      waiter.settle("granted");
    }
  }
}
