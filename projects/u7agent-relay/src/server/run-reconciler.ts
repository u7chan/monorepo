import type { RunRecord, Store } from "./db";
import { sessionRunPayload } from "./relay";
import type { UpstreamClient } from "./upstream";

/** 上流で見つからない実行を「追い越された」と確定するまでの猶予。 */
const STALE_GRACE_MS = 24 * 60 * 60 * 1000;

export type RunReconciler = ReturnType<typeof createRunReconciler>;

/**
 * Bearer クライアントの返信取得に依存せず、上流の実行状態を履歴へ反映する。
 * クライアントが離脱しても、完了した応答を GUI の実行履歴から読めるようにするため。
 */
export function createRunReconciler(options: {
  store: Store;
  upstream: UpstreamClient;
  now: () => number;
  retentionMs: number;
  staleGraceMs?: number;
}) {
  const { store, upstream, now } = options;
  const staleGraceMs = options.staleGraceMs ?? STALE_GRACE_MS;
  /** 上流が遅いときに周期実行が重ならないようにする。次回の周期で追いつく。 */
  let busy = false;

  return {
    async reconcile(): Promise<void> {
      if (busy) {
        return;
      }

      busy = true;

      try {
        await reconcileOnce();
      } finally {
        busy = false;
      }
    },
  };

  async function reconcileOnce(): Promise<void> {
    store.pruneRuns(now() - options.retentionMs);

    const grouped = new Map<string, RunRecord[]>();

    for (const run of store.listPendingRuns()) {
      const runs = grouped.get(run.connectionId) ?? [];

      runs.push(run);
      grouped.set(run.connectionId, runs);
    }

    // 上流への同時接続を増やさないよう、接続先ごとに順番に問い合わせる。
    for (const [connectionId, runs] of grouped) {
      const connection = store.getConnection(connectionId);

      if (!connection) {
        continue;
      }

      let session;

      try {
        session = await upstream.readSession(connection);
      } catch {
        // 一時的な失敗で履歴を消さない。次の周期で再試行する。
        continue;
      }

      for (const run of runs) {
        if (session.run?.id !== run.runId) {
          // 上流は直近の実行だけを返す。猶予を過ぎても見つからない実行は、もう結果を取得できない。
          if (now() - run.createdAt > staleGraceMs) {
            store.updatePendingRun(run.runId, "error", null, "run_missing", now());
          }

          continue;
        }

        try {
          const payload = sessionRunPayload(session, run.runId, connection);

          if (payload.status === "running") {
            continue;
          }

          store.completeRun(
            run.runId,
            payload.status,
            payload.status === "completed" ? payload.text : null,
            payload.status === "error" ? "upstream_error" : null,
            payload.status === "completed" ? payload.files : [],
            now(),
          );
        } catch {
          // 解釈できない応答は次回に回す。
        }
      }
    }
  }
}
