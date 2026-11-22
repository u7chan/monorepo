import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { html } from "hono/html";
import { Page } from "./page";

export const PORT = 8790;
const hosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const clientSecretUrl = "https://api.openai.com/v1/realtime/client_secrets";
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self' https://api.openai.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

type UpstreamRequest = (url: string, options: RequestInit) => Promise<Response>;

export function createApp(request: UpstreamRequest = fetch) {
  const app = new Hono();
  let apiKey: string | null = null;

  app.onError((_error, c) => c.json({ error: "ローカルサーバーでエラーが発生しました。" }, 500));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", csp);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("Permissions-Policy", "microphone=(self), camera=()");

    // ループバック待受だけでは、DNS リバインディングで別ホスト名から到達できる。
    const host = c.req.header("host");
    if (!host || !hosts.has(host)) return c.text("Forbidden host", 403);

    if (c.req.path.startsWith("/api/")) {
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      if (
        ((origin !== undefined || c.req.method !== "GET") && origin !== `http://${host}`) ||
        (site !== undefined && site !== "same-origin")
      ) {
        return c.json({ error: "同一オリジンから操作してください。" }, 403);
      }
    }
    await next();
  });

  app.get("/", (c) => c.html(html`<!doctype html>${<Page />}`));
  for (const [name, type] of [
    ["app.js", "text/javascript; charset=utf-8"],
    ["transcription.js", "text/javascript; charset=utf-8"],
    ["style.css", "text/css; charset=utf-8"],
  ]) {
    const asset = Bun.file(new URL(`../public/${name}`, import.meta.url));
    app.get(`/${name}`, async (c) => c.body(await asset.text(), 200, { "Content-Type": type }));
  }

  app.get("/api/key", (c) => c.json({ registered: apiKey !== null }));
  app.put(
    "/api/key",
    bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "入力が長すぎます。" }, 413) }),
    async (c) => {
      if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json") {
        return c.json({ error: "JSON を送信してください。" }, 415);
      }
      const body = await c.req.json().catch(() => null);
      const key = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
      if (!/^[\x21-\x7e]{1,1024}$/.test(key)) {
        return c.json({ error: "OpenAI API キーを入力してください。" }, 400);
      }
      apiKey = key;
      return c.json({ registered: true });
    },
  );
  app.delete("/api/key", (c) => {
    apiKey = null;
    return c.json({ registered: false });
  });

  app.post("/api/session", async (c) => {
    const key = apiKey;
    if (!key) return c.json({ error: "先に OpenAI API キーを登録してください。" }, 409);
    try {
      const upstream = await request(clientSecretUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          expires_after: { anchor: "created_at", seconds: 60 },
          session: {
            type: "transcription",
            audio: { input: { transcription: { model: "gpt-live-transcribe" }, turn_detection: null } },
          },
        }),
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return c.json({ error: `OpenAI の短命キー発行に失敗しました（HTTP ${upstream.status}）。` }, 502);
      }
      const secret = await upstream.json().catch(() => null);
      if (
        secret?.session?.type !== "transcription" ||
        typeof secret.value !== "string" ||
        !/^ek_[A-Za-z0-9_-]+$/.test(secret.value) ||
        secret.value === key
      ) {
        return c.json({ error: "OpenAI から文字起こし用の短命キーを取得できませんでした。" }, 502);
      }
      if (apiKey !== key) {
        return c.json({ error: "API キーが変更されました。録音を開始し直してください。" }, 409);
      }
      return c.json({ value: secret.value });
    } catch {
      return c.json({ error: "短命キー発行のため OpenAI に接続できませんでした。" }, 502);
    }
  });

  return app;
}
