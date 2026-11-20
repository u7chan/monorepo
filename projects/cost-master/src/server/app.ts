import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  SERVICE_NAME,
  isMasterKind,
  type CostMasterError,
  type CostMasterHealth,
  type CostMasterPayload,
  type JudgmentApplied,
  type JudgmentUpdate,
} from "../shared/contract";
import { parseJudgmentFile, planJudgment } from "./master";
import type { MasterStore } from "./master-store";

export type MasterState = { ok: true; payload: CostMasterPayload } | { ok: false };

export type AppDeps = {
  master: () => MasterState;
  store: MasterStore;
};

/** マスタのアップロード上限。実データは 30 KiB 程度で、1 MiB を超えるものは壊れた入力として扱う */
export const MASTER_UPLOAD_MAX_BYTES = 1_048_576;

/** 1 行だけ変える要求の上限。`modelId` と boolean だけなので、全体を置き換えるアップロードと分ける */
export const JUDGMENT_MAX_BYTES = 16_384;

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

    // マスタは更新されうるので、中間キャッシュに古い価格を返させない
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

  // 画面から編集して返すためのダウンロード。アップロードの前に現在値を取れるようにする
  app.get("/api/master/:kind", (c) => {
    const kind = c.req.param("kind");

    if (!isMasterKind(kind)) {
      return c.json({ error: "not_found" }, 404);
    }

    const text = deps.store.raw(kind);

    if (text === null) {
      return c.json({ error: "not_found" }, 404);
    }

    return c.body(text, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${kind}.json"`,
    });
  });

  app.put(
    "/api/master/:kind",
    bodyLimit({
      maxSize: MASTER_UPLOAD_MAX_BYTES,
      onError: (c) => c.json({ error: "too_large" }, 413),
    }),
    async (c) => {
      const kind = c.req.param("kind");

      if (!isMasterKind(kind)) {
        return c.json({ error: "not_found" }, 404);
      }

      if (!isSameOrigin(c.req.raw)) {
        return c.json({ error: "cross_origin" }, 403);
      }

      let text: string;

      try {
        text = await c.req.text();
      } catch {
        return c.json({ error: "invalid", reason: "body" }, 400);
      }

      const replaced = deps.store.replace(kind, text);

      if (!replaced.ok) {
        return c.json({ error: "invalid", reason: replaced.reason }, 400);
      }

      return c.json({ applied: true, ...healthOf(replaced.state) });
    },
  );

  // 画面のスイッチから 1 行だけ変える。全体を置き換えるアップロードとは別の経路
  app.put(
    "/api/judgments",
    bodyLimit({
      maxSize: JUDGMENT_MAX_BYTES,
      onError: (c) => c.json({ error: "too_large" }, 413),
    }),
    async (c) => {
      if (!isSameOrigin(c.req.raw)) {
        return c.json({ error: "cross_origin" }, 403);
      }

      const update = await readJudgmentUpdate(c.req.raw);

      if ("reason" in update) {
        return c.json({ error: "invalid", reason: update.reason }, 400);
      }

      // ファイル単位の破損は要求値に依らず 503 に倒す。no-op の判定より先に置かないと、
      // 壊れた prices.json で 200 と 503 が割れる
      if (!deps.master().ok) {
        return masterUnavailable(c);
      }

      const text = deps.store.raw("enabled");

      if (text === null) {
        return masterUnavailable(c);
      }

      let value: unknown;

      try {
        value = JSON.parse(text) as unknown;
      } catch {
        return masterUnavailable(c);
      }

      const parsed = parseJudgmentFile(value);

      if (!parsed.ok) {
        return masterUnavailable(c);
      }

      // 落とされる行があると、同じ内容でも要求値によって 200 と 400 が割れる。先に止めて一定にする
      if (parsed.dropped.length > 0) {
        return c.json({ error: "invalid", reason: "rows" }, 400);
      }

      const plan = planJudgment(value, update.modelId, update.enabled);

      if (plan === null) {
        return masterUnavailable(c);
      }

      if (!plan.changed) {
        const applied: JudgmentApplied = { applied: true };

        return c.json(applied);
      }

      const replaced = deps.store.replace("enabled", plan.text);

      if (!replaced.ok) {
        return replaced.reason === "rows"
          ? c.json({ error: "invalid", reason: replaced.reason }, 400)
          : masterUnavailable(c);
      }

      const applied: JudgmentApplied = { applied: true };

      return c.json(applied);
    },
  );

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

function masterUnavailable(c: Context) {
  const body: CostMasterError = { error: "master_unavailable" };

  return c.json(body, 503);
}

/** 要求の形だけを見る。現在のマスタと突き合わせる判定は呼び出し側で行う */
async function readJudgmentUpdate(
  request: Request,
): Promise<JudgmentUpdate | { reason: "body" | "model-id" | "enabled" }> {
  let text: string;

  try {
    text = await request.text();
  } catch {
    return { reason: "body" };
  }

  let value: unknown;

  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { reason: "body" };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { reason: "body" };
  }

  const row = value as { modelId?: unknown; enabled?: unknown };

  if (typeof row.modelId !== "string" || row.modelId === "") {
    return { reason: "model-id" };
  }

  if (typeof row.enabled !== "boolean") {
    return { reason: "enabled" };
  }

  return { modelId: row.modelId, enabled: row.enabled };
}

/**
 * ブラウザからの別サイト送信を弾く。認証を持たないので、ここが書き込み面の唯一の統制になる。
 * Origin が無い要求（curl など）は通す — LAN / VPN の内側からしか到達できない前提を変えない。
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  if (origin === null || origin === "") {
    return true;
  }

  const host = request.headers.get("host");

  if (host === null || host === "") {
    return false;
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
