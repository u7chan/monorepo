import type { Context } from "hono";

export async function mutationOriginGuard(c: Context, next: () => Promise<void>) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) return next();

  const origin = c.req.header("origin");
  const site = c.req.header("sec-fetch-site");
  // Vite の proxy は外部 Host を保持する。転送ヘッダから別の許可オリジンを組まない。
  const targetOrigin = new URL(c.req.url).origin;
  if ((origin !== undefined && origin !== targetOrigin) || (site !== undefined && site !== "same-origin")) {
    return c.json({ error: "Cross-origin mutations are forbidden" }, 403);
  }
  // Origin / Fetch Metadata の無い curl 等は従来どおり許可する。これは認証ではない。
  await next();
}
