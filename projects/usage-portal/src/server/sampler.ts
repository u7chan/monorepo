import { pruneSamples, saveProviderError, saveProviderSnapshot, type DatabaseHandle } from "./db";
import type { ProviderDefinition } from "./providers";
import { ProviderError, type ProviderSnapshot } from "./providers/types";

export const SAMPLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type UsageFetcher = { provider: ProviderDefinition; fetch: () => Promise<ProviderSnapshot> };

export type Sampler = {
  start: () => void;
  stop: () => void;
  /** 5 分の待ちを待たずに 1 回取り直す。進行中の取得があれば、その完了後にもう 1 回走らせる。 */
  kick: () => Promise<void>;
  /**
   * 進行中の取得と重ならない区間で `fn` を実行し、その後に 1 回取り直す。
   * サインアウトで消した snapshot を、先に始まっていた取得が書き戻すのを防ぐための入口。
   */
  exclusive: (fn: () => void) => Promise<void>;
};

/**
 * 起動直後と `intervalMs` ごとに上流を取り、SQLite へ書く。
 * 前回が終わる前にタイマーが来たら開始しない（上流のレート制限を自分で叩かないため）。
 */
export function createSampler(options: {
  db: DatabaseHandle;
  fetchers: readonly UsageFetcher[];
  intervalMs: number;
  retentionMs?: number;
  now: () => number;
  log?: (message: string) => void;
}): Sampler {
  const retentionMs = options.retentionMs ?? SAMPLE_RETENTION_MS;
  const log = options.log ?? ((message: string) => console.warn(`[usage-portal] ${message}`));
  let timer: ReturnType<typeof setInterval> | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;

  function executeOnce(): Promise<void> {
    return Promise.all(
      options.fetchers.map(async ({ provider, fetch }) => {
        try {
          const snapshot = await fetch();

          saveProviderSnapshot(options.db, snapshot);
        } catch (error) {
          const failure = toProviderError(error);

          saveProviderError(options.db, provider.id, {
            code: failure.code,
            message: failure.message,
            at: options.now(),
          });

          // 上流の本文や例外文は残さない。どの provider がどの分類で落ちたかだけを残す。
          log(`${provider.id}: ${failure.code} (${failure.message})`);
        }
      }),
    ).then(() => undefined);
  }

  function runOnce(): Promise<void> {
    if (running) {
      return running;
    }

    running = executeOnce().finally(() => {
      running = null;
    });

    return running;
  }

  function prune(): void {
    pruneSamples(options.db, options.now() - retentionMs);
  }

  function start(): void {
    if (timer) {
      return;
    }

    prune();
    void runOnce();
    timer = setInterval(() => void runOnce(), options.intervalMs);
    pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
    // 取得の待ちでプロセスを終了できなくしない。止めるのは stop() の役目。
    timer.unref?.();
    pruneTimer.unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    if (pruneTimer) {
      clearInterval(pruneTimer);
      pruneTimer = null;
    }
  }

  // 進行中の取得を待ってから fn を実行する。await の後に再開するのは microtask で、
  // タイマーの runOnce より先に fn が走るため、間に新しい取得は挟まらない。
  async function exclusive(fn: () => void): Promise<void> {
    if (running) {
      await running.catch(() => undefined);
    }

    fn();

    await runOnce();
  }

  return { start, stop, kick: () => exclusive(() => {}), exclusive };
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  // 想定外の例外文には token や URL が混ざり得る。分類だけを残し、文言は固定へ寄せる。
  return new ProviderError("upstream", "利用枠を取得できませんでした");
}
