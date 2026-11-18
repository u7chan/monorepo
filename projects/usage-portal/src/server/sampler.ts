import { pruneSamples, saveProviderError, saveProviderSnapshot, type DatabaseHandle } from "./db";
import type { ProviderDefinition } from "./providers";
import { ProviderError, type ProviderId, type ProviderSnapshot } from "./providers/types";

export const SAMPLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 取得予定を確認する間隔。画面から選べる最短の 5 分より短くしておく。 */
export const TICK_INTERVAL_MS = 60 * 1000;

/** source id は `codex:<account>` または `opencode-go:<uuid>`。1 つの provider に複数の source がぶら下がる。 */
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
   * 追加取得につなげないための入口。排他区間そのものは常に保つ。
   */
  refresh?: boolean;
  /** 取り直す provider。省略すると全 provider を対象にする。 */
  provider?: ProviderId;
};

export type Sampler = {
  start: () => void;
  stop: () => void;
  /** 予定を待たずに取り直す。provider を省略すると全 source。進行中の取得は完了後にもう 1 回走らせる。 */
  kick: (provider?: ProviderId) => Promise<void>;
  /**
   * 進行中の取得と重ならない区間で `fn` を実行し、その後に取り直す。
   * サインアウトで消した snapshot を、先に始まっていた取得が書き戻すのを防ぐための入口。
   */
  exclusive: (fn: () => void, options?: ExclusiveOptions) => Promise<void>;
  /** 予定を過ぎた source だけを取得する。タイマーとテストから呼ぶ。 */
  tick: () => Promise<void>;
  /** 次回の取得予定。まだ予定が無い source は `null`。 */
  nextFetchAt: (sourceId: string) => number | null;
  /** 設定変更後の再スケジュール。取り直しはしない。 */
  reschedule: (provider: ProviderId) => void;
};

/**
 * 起動直後と、source ごとの次回予定ごとに上流を取り、SQLite へ書く。
 * 同じ source の取得は重ねない（上流のレート制限を自分で叩かないため）。
 */
export function createSampler(options: {
  db: DatabaseHandle;
  /** 取得のたびに評価する。アカウントの追加・削除を再起動なしで次の取得から反映するため。 */
  fetchers: () => readonly UsageFetcher[];
  /** provider ごとの取得間隔。設定変更を次の取得から反映するため、取得のたびに評価する。 */
  intervalFor: (provider: ProviderId) => number;
  tickMs?: number;
  retentionMs?: number;
  now: () => number;
  log?: (message: string) => void;
}): Sampler {
  const retentionMs = options.retentionMs ?? SAMPLE_RETENTION_MS;
  const tickMs = options.tickMs ?? TICK_INTERVAL_MS;
  const log = options.log ?? ((message: string) => console.warn(`[usage-portal] ${message}`));
  let timer: ReturnType<typeof setInterval> | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  // source ごとの次回取得予定。行が無い source は起動直後・追加直後として扱う。
  const nextDueAt = new Map<string, number>();
  // source ごとの進行中取得。別 provider の取得を互いに待たせない。
  const running = new Map<string, Promise<void>>();
  // exclusive を呼んだ順に直列化する。前の変更後の再取得が終わるまで、次の変更を始めない。
  let exclusiveChain: Promise<void> = Promise.resolve();
  // 変更中は tick から取得を始めない。待機中に始まった取得が、削除した snapshot を書き戻すのを防ぐ。
  // 呼んだ時点で数える。鎖に並んだ 2 つ目が始まる前の隙間でも、tick を止めるため。
  let pendingMutations = 0;

  function runFetcher(fetcher: UsageFetcher): Promise<void> {
    // 開始時点で次回を決める。取得が長引いても間隔を詰めない。
    nextDueAt.set(fetcher.sourceId, options.now() + options.intervalFor(fetcher.provider.id));

    const task = (async () => {
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
    })().finally(() => {
      running.delete(fetcher.sourceId);
    });

    running.set(fetcher.sourceId, task);

    return task;
  }

  function execute(fetchers: readonly UsageFetcher[]): Promise<void> {
    const tasks = fetchers.map(runFetcher);

    // 1 つの DB 書き込み失敗で他 provider の取得を打ち切らない。running が全 provider の
    // 終了より先に解けると、exclusive がまだ進行中の取得を見落とす。
    return Promise.allSettled(tasks).then((results) => {
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");

      if (rejected) {
        throw rejected.reason;
      }
    });
  }

  function tick(): Promise<void> {
    if (pendingMutations > 0) {
      return Promise.resolve();
    }

    const now = options.now();
    const due = options.fetchers().filter((fetcher) => {
      const scheduledAt = nextDueAt.get(fetcher.sourceId);

      return !running.has(fetcher.sourceId) && (scheduledAt === undefined || scheduledAt <= now);
    });

    return due.length === 0 ? Promise.resolve() : execute(due);
  }

  function prune(): void {
    pruneSamples(options.db, options.now() - retentionMs);
  }

  function runInBackground(): void {
    void tick().catch(() => log("取得結果を保存できませんでした"));
  }

  function start(): void {
    if (timer) {
      return;
    }

    prune();
    runInBackground();
    timer = setInterval(runInBackground, tickMs);
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

  /** 進行中の取得を待ってから、対象の source をもう一度取り直す。 */
  async function refresh(provider?: ProviderId): Promise<void> {
    const selected = options.fetchers().filter((fetcher) => provider === undefined || fetcher.provider.id === provider);
    const ids = new Set(selected.map((fetcher) => fetcher.sourceId));
    const inFlight = [...running.entries()].filter(([sourceId]) => ids.has(sourceId)).map(([, task]) => task);

    if (inFlight.length > 0) {
      await Promise.allSettled(inFlight);
    }

    const again = options.fetchers().filter((fetcher) => ids.has(fetcher.sourceId) && !running.has(fetcher.sourceId));

    if (again.length === 0) {
      return;
    }

    // 変更は確定している。後続の取得や保存の失敗は操作の失敗として返さない。
    await execute(again).catch(() => log("取得結果を保存できませんでした"));
  }

  // 進行中の取得を待ってから fn を実行する。待ったあとに running を再確認しないので、
  // 同時に呼ばれた exclusive を鎖でつなぎ、先の変更後の取得が終わるまで次を始めない。
  function exclusive(fn: () => void, exclusiveOptions: ExclusiveOptions = {}): Promise<void> {
    const refreshAfter = exclusiveOptions.refresh ?? true;
    const provider = exclusiveOptions.provider;
    pendingMutations += 1;

    const task = exclusiveChain.then(async () => {
      try {
        // 待つあいだ tick は新しい取得を始めない。開始済みの取得だけを待てばよい。
        while (running.size > 0) {
          await Promise.allSettled([...running.values()]);
        }

        fn();

        if (refreshAfter) {
          await refresh(provider);
        }
      } finally {
        pendingMutations -= 1;
      }
    });

    exclusiveChain = task.catch(() => undefined);

    return task;
  }

  function kick(provider?: ProviderId): Promise<void> {
    const task = exclusiveChain.then(() => refresh(provider));

    exclusiveChain = task.catch(() => undefined);

    return task;
  }

  function reschedule(provider: ProviderId): void {
    const now = options.now();
    const next = now + options.intervalFor(provider);

    for (const fetcher of options.fetchers()) {
      if (fetcher.provider.id !== provider) {
        continue;
      }

      const current = nextDueAt.get(fetcher.sourceId);

      // 短くしたときは前倒しし、長くしたときは既に近い予定を遅らせない。
      nextDueAt.set(fetcher.sourceId, current === undefined ? now : Math.min(current, next));
    }
  }

  return {
    start,
    stop,
    kick,
    exclusive,
    tick,
    nextFetchAt: (sourceId) => nextDueAt.get(sourceId) ?? null,
    reschedule,
  };
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
