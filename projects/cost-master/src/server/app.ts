import { Hono } from "hono";
import { SERVICE_NAME, type CostMasterError, type CostMasterHealth, type CostMasterPayload } from "../shared/contract";

export type MasterState = { ok: true; payload: CostMasterPayload } | { ok: false };

export type AppDeps = {
  master: () => MasterState;
};

/**
 * API は JSON しか返さないので、読み込みも実行もさせない。文書の CSP は index.html の meta で指定する
 * （Bun の HTML ルートはハンドラを通らず、応答ヘッダーを足せないため）。
 */
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      c.header(name, value);
    }

    // マスタはデプロイでしか変わらないが、u7agent は手動更新のときだけ読む。中間キャッシュに古い価格を返させない
    c.header("Cache-Control", "no-store");
  });

  app.get("/api/models", (c) => {
    const state = deps.master();

    if (!state.ok) {
      const body: CostMasterError = { error: "master_unavailable" };

      return c.json(body, 503);
    }

    return c.json(state.payload);
  });

  app.get("/api/health", (c) => c.json(healthOf(deps.master())));

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}

export function healthOf(state: MasterState): CostMasterHealth {
  if (!state.ok) {
    return { ok: false, service: SERVICE_NAME, masterFetchedAt: null, version: null };
  }

  return {
    ok: true,
    service: SERVICE_NAME,
    masterFetchedAt: state.payload.fetchedAt,
    version: state.payload.version,
  };
}
