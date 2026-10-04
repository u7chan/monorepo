/**
 * サービス (serve) オリジンのプロキシ。3 本目のリスナーが受け、`PI_SANDBOX_URL` のホストの
 * 8080 (固定) へ転送する。公開枠は全会話で共有の 1 本で URL をアプリごとに分けられないため、
 * 置き換えの後に前のアプリの本文がブラウザ キャッシュから再利用されないよう、ここでヘッダを
 * 正規化する (設計は docs/sandbox.md の serve の節を正とする)。
 */
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { SERVE_LISTEN_PORT } from "./preview-port";

/**
 * 上流へ渡さない / ブラウザへ返さないホップバイホップ ヘッダ。これらは 1 本の接続のための値で、
 * 転送すると Content-Length や chunked の整合が壊れる。`Expect` も上流の 100-continue 待ちで
 * 止まりうるため落とす (Node のクライアントが面倒を見る)。
 */
const HOP_BY_HOP = new Set([
  "connection",
  "expect",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * GET / HEAD だけ落とす再検証ヘッダ。no-store を付けても、ブラウザが持っている古い本文の
 * バリデータ (`If-None-Match` / `If-Modified-Since`) を上流へ通すと、置き換え先の `Last-Modified`
 * が置き換え元以下・同一のときに 304 が成立し、前の本文が再利用されてしまう。`Last-Modified` は
 * URL をまたいで比較できない値なので、再検証には賭けない。書き込みメソッドの `If-None-Match: *`
 * などは前提条件 (不成立なら 412) なので消さずに透過させる。
 */
const REVALIDATION_HEADERS = new Set(["if-none-match", "if-modified-since"]);

/** 内部ホストを指す `Location` をブラウザから見たオリジンへ直す。アプリが自分の待受として返しうる値 (IPv6 は URL が角括弧付きで返す) */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1", "[::1]"]);

export interface ServiceProxyOptions {
  /** 転送先ホスト。未設定 (PI_SANDBOX_URL なし) は 502 を返す */
  host?: string;
  /** 転送先ポート。テスト以外は既定の 8080 固定 (任意ポートは受けない) */
  port?: number;
}

/** `Connection` が名指ししたヘッダもホップバイホップなので落とす */
function hopByHopNames(connection: string | undefined): Set<string> {
  const names = new Set(HOP_BY_HOP);
  for (const token of (connection ?? "").split(",")) {
    const name = token.trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

/** `Location` が内部ホスト (u7agent-sandbox:8080 / 127.0.0.1:8080 など) なら、ブラウザから見たオリジンの URL へ直す */
export function rewriteLocation(location: string, browserOrigin: string, sandboxHost: string | undefined): string {
  const hosts = new Set(LOCAL_HOSTS);
  if (sandboxHost) {
    const host = sandboxHost.toLowerCase();
    hosts.add(host);
    hosts.add(`[${host}]`);
  }
  let target: URL;
  try {
    target = new URL(location, browserOrigin);
  } catch {
    return location;
  }
  if (!hosts.has(target.hostname.toLowerCase())) return location;
  return `${browserOrigin}${target.pathname}${target.search}${target.hash}`;
}

/** 上流停止時の短い 502。稼働中 / 停止中の判定は serve のプローブが正で、ここは HTTP の到達だけを返す */
function unreachableResponse(): Response {
  return Response.json({ error: "サービスに接続できません" }, { status: 502 });
}

/**
 * 上流の応答をブラウザへ返す。ボディはバッファせずストリームのまま渡し、キャッシュに関わる
 * ヘッダは `Cache-Control: no-store` に一本化する (上流の値は落とす)。
 */
function forwardResponse(
  upstream: IncomingMessage,
  browserOrigin: string,
  sandboxHost: string | undefined,
  method: string,
): Response {
  const drop = hopByHopNames(upstream.headers.connection);
  const headers = new Headers();
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined) continue;
    if (drop.has(name) || name === "cache-control" || name === "expires") continue;
    // Set-Cookie は複数値を保つ必要があるため append で積む
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  headers.set("cache-control", "no-store");
  const location = headers.get("location");
  if (location) headers.set("location", rewriteLocation(location, browserOrigin, sandboxHost));

  const status = upstream.statusCode ?? 502;
  // 204 / 304 と HEAD は本文を持てない (Response のコンストラクタが拒否する)
  const body =
    method === "HEAD" || status === 204 || status === 304
      ? null
      : (Readable.toWeb(upstream) as ReadableStream<Uint8Array>);
  return new Response(body, { status, headers });
}

export function createServiceProxy(options: ServiceProxyOptions = {}) {
  const port = options.port ?? SERVE_LISTEN_PORT;
  const host = options.host?.trim() || undefined;

  const app = new Hono();
  app.all("*", async (c) => {
    if (!host) return unreachableResponse();
    const url = new URL(c.req.url);
    const method = c.req.method;
    const drop = hopByHopNames(c.req.raw.headers.get("connection") ?? undefined);
    const revalidate = method === "GET" || method === "HEAD";
    const headers: Record<string, string> = {};
    for (const [name, value] of c.req.raw.headers) {
      if (drop.has(name) || name === "host") continue;
      if (revalidate && REVALIDATION_HEADERS.has(name)) continue;
      headers[name] = value;
    }
    const body = revalidate ? null : c.req.raw.body;

    return await new Promise<Response>((resolve) => {
      // Node の fetch は Content-Encoding を復号してヘッダだけ残すため、バイト列をそのまま扱う
      const upstreamRequest = httpRequest(
        { host, port, method, path: `${url.pathname}${url.search}`, headers },
        (upstream) => resolve(forwardResponse(upstream, url.origin, host, method)),
      );
      upstreamRequest.once("error", () => resolve(unreachableResponse()));
      c.req.raw.signal.addEventListener("abort", () => upstreamRequest.destroy(), { once: true });
      if (body) Readable.fromWeb(body).pipe(upstreamRequest);
      else upstreamRequest.end();
    });
  });
  return app;
}
