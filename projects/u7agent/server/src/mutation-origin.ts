import type { Context } from "hono";

/**
 * 変更系 API の Origin / Fetch Metadata 検査。`appOrigin` はブラウザから見た公開オリジンで、TLS 終端の
 * 後ろではリクエスト自身の origin (`http://<host>`) とブラウザの Origin (`https://<host>`) がずれる。
 * 設定済みでもリクエスト自身の origin を許可し続けるのは、移行期間に直通ポート経由の HTTP 操作を
 * 壊さないため。`X-Forwarded-*` から許可オリジンを増やさないのは現行と同じ。
 */
export function mutationOriginGuard(appOrigin?: string) {
  return async (c: Context, next: () => Promise<void>) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) return next();

    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    // Vite の proxy は外部 Host を保持する。転送ヘッダから別の許可オリジンを組まない。
    const targetOrigin = new URL(c.req.url).origin;
    // appOrigin が未設定なら undefined との比較は常に不一致なので、現行の「リクエスト自身の origin だけ」に戻る
    const allowed = origin === targetOrigin || origin === appOrigin;
    if ((origin !== undefined && !allowed) || (site !== undefined && site !== "same-origin")) {
      return c.json({ error: "Cross-origin mutations are forbidden" }, 403);
    }
    // Origin / Fetch Metadata の無い curl 等は従来どおり許可する。これは認証ではない。
    await next();
  };
}

/**
 * Git の設定 API 専用の厳格な検査。上の mutationOriginGuard はヘッダの無い直接クライアントを許可するが、
 * この設定は全会話の commit identity を変えられるため、ブラウザの same-origin 要求だけを通す。
 * サンドボックスから BFF へ到達できる配備では直接のバイパスになるので、認証の代わりではないが
 * defense-in-depth として置く (docs/sandbox.md#git-identity)。
 */
export function sameOriginOnlyGuard(appOrigin?: string) {
  return async (c: Context, next: () => Promise<void>) => {
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    const targetOrigin = new URL(c.req.url).origin;
    const originAllowed = origin !== undefined && (origin === targetOrigin || origin === appOrigin);
    if (!originAllowed && site !== "same-origin") {
      return c.json({ error: "Same-origin request required" }, 403);
    }
    await next();
  };
}
