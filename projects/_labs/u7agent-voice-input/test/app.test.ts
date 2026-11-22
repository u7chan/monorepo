import { expect, mock, test } from "bun:test";
import { createApp, PORT } from "../src/app";

const host = `localhost:${PORT}`;
const origin = `http://${host}`;
const fixtureKey = "fixture-key-not-a-secret";

function local(app: ReturnType<typeof createApp>, path: string, options: RequestInit = {}) {
  const headers = new Headers({ host, origin, "sec-fetch-site": "same-origin" });
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  return app.request(`${origin}${path}`, { ...options, headers });
}

function register(app: ReturnType<typeof createApp>, apiKey = fixtureKey) {
  return local(app, "/api/key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
}

test("GET / は同一オリジンの JS/CSS を読む HTML を返す", async () => {
  const app = createApp();
  const page = await local(app, "/");
  expect(page.status).toBe(200);
  expect(await page.text()).toStartWith('<!doctype html><html lang="ja">');
  expect(page.headers.get("Content-Security-Policy")).toContain("connect-src 'self' https://api.openai.com");
  for (const [path, type] of [
    ["/app.js", "text/javascript"],
    ["/transcription.js", "text/javascript"],
    ["/style.css", "text/css"],
  ]) {
    const response = await local(app, path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith(type);
  }
  expect((await local(app, "/.env")).status).toBe(404);
});

test("キーの登録・解除は現在の BFF にだけ反映され、レスポンスには登録状態しか出ない", async () => {
  const upstream = mock(async () => new Response(null, { status: 401 }));
  const app = createApp(upstream);
  const status = (target = app) => local(target, "/api/key");
  const issueSecret = () => local(app, "/api/session", { method: "POST" });
  expect(await (await status()).json()).toEqual({ registered: false });
  expect((await issueSecret()).status).toBe(409);
  const registered = await register(app);
  expect(registered.headers.get("Cache-Control")).toBe("no-store");
  expect(await registered.json()).toEqual({ registered: true });
  expect(await (await status()).json()).toEqual({ registered: true });
  expect(await (await status(createApp())).json()).toEqual({ registered: false });

  const deleted = await local(app, "/api/key", { method: "DELETE" });
  expect(await deleted.json()).toEqual({ registered: false });
  expect((await issueSecret()).status).toBe(409);
  expect(upstream).not.toHaveBeenCalled();
});

test("待受ホスト以外の要求と同一オリジンでないキー操作・発行要求を拒否する", async () => {
  const upstream = mock(async () => new Response(null, { status: 401 }));
  const app = createApp(upstream);
  await register(app);
  expect((await local(app, "/", { headers: { host: "different.example" } })).status).toBe(403);
  expect((await app.request(`${origin}/api/key`, { method: "DELETE", headers: { host } })).status).toBe(403);
  expect((await local(app, "/api/key", { method: "DELETE", headers: { origin: "null" } })).status).toBe(403);
  expect((await local(app, "/api/session", { method: "POST", headers: { origin: "https://different.example" } })).status).toBe(403);
  expect((await local(app, "/api/session", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  expect(await (await local(app, "/api/key")).json()).toEqual({ registered: true });
  expect(upstream).not.toHaveBeenCalled();
});

test("不正なキー入力は登録しない", async () => {
  const app = createApp();
  expect((await register(app, "  ")).status).toBe(400);
  expect((await register(app, "x".repeat(4096))).status).toBe(413);
  expect((await local(app, "/api/key", { method: "PUT", body: fixtureKey })).status).toBe(415);
  expect(await (await local(app, "/api/key")).json()).toEqual({ registered: false });
});

test("通常キーで文字起こし専用の短命キーを発行し、短命キーのみ返す", async () => {
  const upstream = mock(async (_url: string, _init?: RequestInit) => Response.json({
    value: "ek_fixture",
    session: { type: "transcription" },
    extra: fixtureKey,
  }));
  const app = createApp(upstream);
  await register(app);
  const response = await local(app, "/api/session", { method: "POST" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ value: "ek_fixture" });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(upstream).toHaveBeenCalledTimes(1);
  const [url, init] = upstream.mock.calls[0];
  expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
  expect(init?.method).toBe("POST");
  expect(init?.redirect).toBe("error");
  expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${fixtureKey}`);
  expect(JSON.parse(String(init?.body))).toEqual({
    expires_after: { anchor: "created_at", seconds: 60 },
    session: {
      type: "transcription",
      audio: { input: { transcription: { model: "gpt-live-transcribe" }, turn_detection: null } },
    },
  });
});

test("OpenAI が本文に通常キーを含めてエラーを返しても、HTTP ステータスだけを伝える", async () => {
  const app = createApp(async () => Response.json({ error: fixtureKey }, { status: 401 }));
  await register(app);
  const response = await local(app, "/api/session", { method: "POST" });
  expect(response.status).toBe(502);
  const text = await response.text();
  expect(text).toContain("HTTP 401");
  expect(text).not.toContain(fixtureKey);
});

test("別タイプのセッション・通常キーの応答はブラウザに渡さない", async () => {
  const key = "ek_fixture_regular_key";
  for (const data of [
    { value: "ek_fixture", session: { type: "realtime" } },
    { value: key, session: { type: "transcription" } },
  ]) {
    const app = createApp(async () => Response.json(data));
    await register(app, key);
    const response = await local(app, "/api/session", { method: "POST" });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(data.value);
  }
});

test("発行中にキーを解除した場合は後から返った短命キーを渡さない", async () => {
  const requested = Promise.withResolvers<void>();
  const issued = Promise.withResolvers<Response>();
  const app = createApp(() => {
    requested.resolve();
    return issued.promise;
  });
  await register(app);
  const pending = local(app, "/api/session", { method: "POST" });
  await requested.promise;
  await local(app, "/api/key", { method: "DELETE" });
  issued.resolve(Response.json({ value: "ek_fixture", session: { type: "transcription" } }));
  const response = await pending;
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("ek_fixture");
});
