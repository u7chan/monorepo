import { pruneSamples, saveProviderError, saveProviderSnapshot, type DatabaseHandle } from "./db";
import type { ProviderDefinition } from "./providers";
import { ProviderError, type ProviderSnapshot } from "./providers/types";

export const SAMPLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** source id は `codex` または `opencode-go:<uuid>`。1 つの provider に複数の source がぶら下がる。 */
export type UsageFetcher = {
  sourceId: string;
  provider: ProviderDefinition;
  /** ログに出す source の呼び名。source id にアカウント識別子が入る場合は伏せた値を渡す。 */
  logLabel?: string;
  fetch: () => Promise<ProviderSnapshot>;
};

export type ExclusiveOptions = {
  /**
   * 変更後に取り直すか（既定は true）。表示名だけの更新のように、上流の値を変えない操作を
   * 全 source の追加取得につなげないための入口。排他区間そのものは常に保つ。
   */
  refresh?: boolean;
};

export type Sampler = {
  start: () => void;
  stop: () => void;
  /** 5 分の待ちを待たずに 1 回取り直す。進行中の取得があれば、その完了後にもう 1 回走らせる。 */
  kick: () => Promise<void>;
  /**
   * 進行中の取得と重ならない区間で `fn` を実行し、その後に 1 回取り直す。
   * サインアウトで消した snapshot を、先に始まっていた取得が書き戻すのを防ぐための入口。
   */
  exclusive: (fn: () => void, options?: ExclusiveOptions) => Promise<void>;
};

/**
 * 起動直後と `intervalMs` ごとに上流を取り、SQLite へ書く。
 * 前回が終わる前にタイマーが来たら開始しない（上流のレート制限を自分で叩かないため）。
 */
export function createSampler(options: {
  db: DatabaseHandle;
  /** 取得のたびに評価する。アカウントの追加・削除を再起動なしで次の取得から反映するため。 */
  fetchers: () => readonly UsageFetcher[];
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
  // exclusive を呼んだ順に直列化する。前の変更後の再取得が終わるまで、次の変更を始めない。
  let exclusiveChain: Promise<void> = Promise.resolve();

  function executeOnce(): Promise<void> {
    // 1 回の取得で 1 回だけ評価する。途中でアカウントが増減しても、この回の対象は変えない。
    const fetchers = options.fetchers();
    const tasks = fetchers.map(async (fetcher) => {
      try {
        const snapshot = await fetcher.fetch();

        saveProviderSnapshot(options.db, fetcher.sourceId, snapshot);
      } catch (error) {
        const failure = toProviderError(error);

        saveProviderError(options.db, fetcher.sourceId, {
          code: failure.code,
          message: failure.message,
          at: options.now(),
        });

        // 上流の本文や例外文は残さない。どの source がどの分類で落ちたかだけを残す。
        // source id は account の uuid を含むが、キーも名前も含まない。
        log(`${describeFetcher(fetcher)}: ${failure.code} (${failure.message})`);
      }
    });

    // 1 つの DB 書き込み失敗で他 provider の取得を打ち切らない。running が全 provider の
    // 終了より先に解けると、exclusive がまだ進行中の取得を見落とす。
    return Promise.allSettled(tasks).then((results) => {
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");

      if (rejected) {
        throw rejected.reason;
      }
    });
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

  function runInBackground(): void {
    void runOnce().catch(() => log("取得結果を保存できませんでした"));
  }

  function start(): void {
    if (timer) {
      return;
    }

    prune();
    runInBackground();
    timer = setInterval(runInBackground, options.intervalMs);
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

  // 進行中の取得を待ってから fn を実行する。待ったあとに running を再確認しないので、
  // 同時に呼ばれた exclusive を鎖でつなぎ、先の変更後の取得が終わるまで次を始めない。
  function exclusive(fn: () => void, exclusiveOptions: ExclusiveOptions = {}): Promise<void> {
    const refresh = exclusiveOptions.refresh ?? true;
    const task = exclusiveChain.then(async () => {
      if (running) {
        await running.catch(() => undefined);
      }

      fn();

      if (!refresh) {
        return;
      }

      // 変更は確定している。後続の取得や保存の失敗は操作の失敗として返さない。
      await runOnce().catch(() => log("取得結果を保存できませんでした"));
    });

    exclusiveChain = task.catch(() => undefined);

    return task;
  }

  return { start, stop, kick: () => exclusive(() => {}), exclusive };
}

function describeFetcher(fetcher: UsageFetcher): string {
  const source = fetcher.logLabel ?? fetcher.sourceId;

  return source === fetcher.provider.id ? fetcher.provider.id : `${fetcher.provider.id} ${source}`;
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  // 想定外の例外文には token や URL が混ざり得る。分類だけを残し、文言は固定へ寄せる。
  return new ProviderError("upstream", "利用枠を取得できませんでした");
}
