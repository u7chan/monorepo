// Discord 通知 (server/src/notifications.ts) の宛先検証 / マスク / 失敗 / 直近結果の順序と、
// HTTP 契約 (write-only / テスト送信 / 再起動後の復元) を検証する。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { AppDb } from "../src/app-db";
import {
  BASE_URL_ERROR,
  deepLink,
  maskWebhook,
  normalizeBaseUrl,
  normalizeWebhookUrl,
  NotificationService,
  WEBHOOK_URL_ERROR,
} from "../src/notifications";
import { createSecretMasker } from "../src/redact";
import type { NotificationResult } from "../src/schema";

const WEBHOOK = "https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz";
const OTHER_WEBHOOK = "https://discord.com/api/webhooks/999/zyxwvutsrqponmlkjihgfedcba";

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const statusOf = (error: unknown): number | undefined => (error as { statusCode?: number }).statusCode;

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-notifications-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** 送信を差し替える。呼び出しは記録し、応答は handler が決める */
function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

function createService(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; masker?: ReturnType<typeof createSecretMasker> } = {},
) {
  const db = AppDb.open({ storeDir: null });
  const service = new NotificationService({
    db,
    masker: options.masker,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  return { db, service };
}

const payloadOf = (call: FetchCall | undefined): any => JSON.parse(String(call?.init?.body));

test("accepts only the canonical discord.com webhook URL", () => {
  assert.equal(normalizeWebhookUrl(WEBHOOK), WEBHOOK);
  // 大文字ホストは正規化した値で保存する
  assert.equal(
    normalizeWebhookUrl("https://DISCORD.COM/api/webhooks/1/token"),
    "https://discord.com/api/webhooks/1/token",
  );
  for (const bad of [
    "http://discord.com/api/webhooks/1/token",
    "https://discordapp.com/api/webhooks/1/token",
    "https://cdn.discord.com/api/webhooks/1/token",
    "https://discord.com.evil.example/api/webhooks/1/token",
    "https://user:pass@discord.com/api/webhooks/1/token",
    "https://discord.com:8443/api/webhooks/1/token",
    "https://discord.com/api/webhooks/1/token?wait=true",
    "https://discord.com/api/webhooks/1/token#fragment",
    "https://discord.com/api/webhooks/1",
    "https://discord.com/api/webhooks/1/token/",
    "https://discord.com/api/webhooks//token",
    "https://discord.com/api/hooks/1/token",
    "https://discord.com/api/webhooks/a%20b/token",
    "not a url",
    "",
  ]) {
    assert.throws(
      () => normalizeWebhookUrl(bad),
      (error) => statusOf(error) === 400,
      bad,
    );
  }
});

test("webhook validation errors never echo the URL", () => {
  const url = "https://evil.example/api/webhooks/1/secret-token";
  try {
    normalizeWebhookUrl(url);
    assert.fail("must throw");
  } catch (error) {
    assert.equal((error as Error).message, WEBHOOK_URL_ERROR);
    assert.equal((error as Error).message.includes(url), false);
    assert.equal((error as Error).message.includes("secret-token"), false);
  }
});

test("the base URL accepts an http(s) origin only", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:5173"), "http://127.0.0.1:5173");
  assert.equal(normalizeBaseUrl("  https://u7.example.com  "), "https://u7.example.com");
  // 空は「リンクを載せない」を表す
  assert.equal(normalizeBaseUrl(""), undefined);
  assert.equal(normalizeBaseUrl("   "), undefined);
  for (const bad of [
    "ftp://u7.example.com",
    "https://u7.example.com/path",
    "https://u7.example.com/?q=1",
    "https://u7.example.com/#frag",
    "https://user@u7.example.com",
    "https://u7.example.com\n.example",
    "u7.example.com",
  ]) {
    assert.throws(
      () => normalizeBaseUrl(bad),
      (error) => statusOf(error) === 400,
      bad,
    );
  }
  try {
    normalizeBaseUrl("ftp://u7.example.com");
    assert.fail("must throw");
  } catch (error) {
    assert.equal((error as Error).message, BASE_URL_ERROR);
  }
});

test("maskWebhook hides the whole URL and any /api/webhooks path", () => {
  assert.equal(maskWebhook(`POST ${WEBHOOK} failed`, [WEBHOOK]), "POST [REDACTED] failed");
  // 既知の URL に無くても、パス部分は潰す (トークンを残さない)
  const unknown = maskWebhook(`POST ${WEBHOOK} failed`);
  assert.equal(unknown.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.match(unknown, /\[REDACTED\]/);
  // 末尾の区切り記号は残す (応答やログの括弧を壊さない)
  assert.equal(maskWebhook("see /api/webhooks/1/token)", []), "see [REDACTED])");
  assert.equal(maskWebhook("no url here", [WEBHOOK]), "no url here");
});

test("deepLink builds /s/<id> from the base URL and skips an unset base", () => {
  assert.equal(deepLink("http://127.0.0.1:5173", "a1b2c3d4e5"), "http://127.0.0.1:5173/s/a1b2c3d4e5");
  assert.equal(deepLink("http://127.0.0.1:5173", "a b"), "http://127.0.0.1:5173/s/a%20b");
  assert.equal(deepLink(undefined, "a1b2c3d4e5"), undefined);
  assert.equal(deepLink("", "a1b2c3d4e5"), undefined);
});

test("a test send posts an embed and stores the shared last result", async () => {
  const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
  const { db, service } = createService({ fetchImpl: impl });
  try {
    assert.deepEqual(service.settings(), { enabled: false, provider: "discord", configured: false, mention: "none" });
    // 設定の保存では送信しない
    assert.equal(calls.length, 0);

    const saved = service.save({
      webhookUrl: WEBHOOK,
      enabled: true,
      baseUrl: "http://127.0.0.1:5173",
      mention: "here",
    });
    assert.equal(saved.configured, true);
    assert.equal(saved.webhookHint, "wxyz");
    assert.equal(saved.baseUrl, "http://127.0.0.1:5173");
    assert.equal(saved.mention, "here");
    assert.equal(calls.length, 0);

    const result = await service.test();
    assert.equal(result.ok, true);
    assert.equal(result.status, 204);
    assert.ok(result.latencyMs >= 0);
    assert.equal(typeof result.at, "number");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, WEBHOOK);
    assert.equal(calls[0].init?.method, "POST");
    // リダイレクトは追わない (3xx でもトークンを転送しない)
    assert.equal(calls[0].init?.redirect, "error");
    const payload = payloadOf(calls[0]);
    assert.deepEqual(payload.allowed_mentions, { parse: ["everyone"] });
    assert.match(payload.embeds[0].title, /テスト通知/);
    assert.deepEqual(service.settings().lastResult, result);
  } finally {
    db.close();
  }
});

test("a Discord error keeps only status / code / message", async () => {
  const { impl } = fakeFetch(
    () => new Response(JSON.stringify({ message: "Unknown Webhook", code: 10015 }), { status: 404 }),
  );
  const { db, service } = createService({ fetchImpl: impl });
  try {
    service.save({ webhookUrl: WEBHOOK });
    const result = await service.test();
    assert.deepEqual(result, {
      ok: false,
      status: 404,
      latencyMs: result.latencyMs,
      message: "Unknown Webhook",
      code: 10015,
      at: result.at,
    });
    assert.equal(JSON.stringify(result).includes("/api/webhooks/"), false);
  } finally {
    db.close();
  }
});

test("a 429 keeps the Retry-After seconds (rounded up) and other statuses ignore retry_after", async () => {
  const rateLimited = async (body: unknown, status = 429) => {
    const { impl } = fakeFetch(() => new Response(JSON.stringify(body), { status }));
    const { db, service } = createService({ fetchImpl: impl });
    try {
      service.save({ webhookUrl: WEBHOOK });
      return await service.test();
    } finally {
      db.close();
    }
  };

  // Discord の retry_after は秒 (小数)。表示用に切り上げる
  const limited = await rateLimited({ message: "You are being rate limited.", retry_after: 1.234 });
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, 2);
  // 待機秒数が無い 429 はフィールドごと省略する (画面は固定文言へフォールバックする)
  assert.equal("retryAfter" in (await rateLimited({ message: "You are being rate limited." })), false);
  // 429 以外では本文に retry_after があっても載せない
  assert.equal(
    "retryAfter" in (await rateLimited({ message: "Unknown Webhook", code: 10015, retry_after: 5 }, 404)),
    false,
  );
  // 読めない値 (文字列 / 負 / 非数値) は載せない
  for (const value of ["1.5", -3, Number.NaN, null, {}]) {
    assert.equal(
      "retryAfter" in (await rateLimited({ message: "slow down", retry_after: value })),
      false,
      String(value),
    );
  }
});

test("a response body cannot leak the webhook URL", async () => {
  const { impl } = fakeFetch(() => new Response(JSON.stringify({ message: `rejected ${WEBHOOK}` }), { status: 500 }));
  const { db, service } = createService({ fetchImpl: impl });
  try {
    service.save({ webhookUrl: WEBHOOK });
    const result = await service.test();
    assert.equal(result.message, "rejected [REDACTED]");
  } finally {
    db.close();
  }
});

test("a fetch failure is reported without the URL", async () => {
  const { impl } = fakeFetch(() => {
    throw new TypeError(`fetch failed: ${WEBHOOK}`);
  });
  const { db, service } = createService({ fetchImpl: impl });
  try {
    service.save({ webhookUrl: WEBHOOK });
    const result = await service.test();
    assert.equal(result.ok, false);
    assert.equal(result.status, undefined);
    assert.equal(result.message, "Discord へ接続できません");
  } finally {
    db.close();
  }
});

test("a send that never resolves times out", async () => {
  const { impl } = fakeFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
  );
  const { db, service } = createService({ fetchImpl: impl, timeoutMs: 10 });
  try {
    service.save({ webhookUrl: WEBHOOK });
    const result = await service.test();
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /タイムアウト/);
  } finally {
    db.close();
  }
});

test("a newer send wins and an older completion does not overwrite it", async () => {
  const pending: Array<(response: Response) => void> = [];
  const { impl } = fakeFetch(() => new Promise<Response>((resolve) => pending.push(resolve)));
  const { db, service } = createService({ fetchImpl: impl });
  try {
    service.save({ webhookUrl: WEBHOOK });
    const older = service.test();
    const newer = service.test();
    assert.equal(pending.length, 2);

    // 新しい方を先に完了させ、そのあと古い方を完了させる
    pending[1](new Response(null, { status: 204 }));
    assert.equal((await newer).status, 204);
    pending[0](new Response(null, { status: 500 }));
    assert.equal((await older).status, 500);
    assert.equal(service.settings().lastResult?.status, 204);
  } finally {
    db.close();
  }
});

test("changing the webhook URL clears the last result and keeps masking the old URL", async () => {
  const { impl } = fakeFetch(() => new Response(JSON.stringify({ message: `boom ${WEBHOOK}` }), { status: 500 }));
  const { db, service } = createService({ fetchImpl: impl });
  try {
    service.save({ webhookUrl: WEBHOOK });
    await service.test();
    assert.ok(service.settings().lastResult);

    const saved = service.save({ webhookUrl: OTHER_WEBHOOK });
    assert.equal(saved.lastResult, undefined);
    assert.equal(saved.webhookHint, "dcba");

    // 変更後も旧 URL をマスクできる (直前に保存した値をメモリに持つ)
    const result = await service.test();
    assert.equal(result.message, "boom [REDACTED]");
  } finally {
    db.close();
  }
});

test("a session notification masks first and truncates after", async () => {
  const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
  const { db, service } = createService({ fetchImpl: impl, masker: createSecretMasker(["SECRET-TOKEN"]) });
  try {
    service.save({ webhookUrl: WEBHOOK, enabled: true, baseUrl: "http://127.0.0.1:5173" });
    service.notifySession({
      sessionId: "a1b2c3d4e5",
      title: "パンくずの折り返しを直す",
      agentName: "実装担当",
      body: `${"a".repeat(190)}SECRET-TOKEN${"b".repeat(50)}`,
      durationMs: 252_000,
      toolCalls: 12,
    });
    await waitFor(() => service.settings().lastResult !== undefined);
    const payload = payloadOf(calls[0]);
    assert.equal(payload.embeds[0].title, "✅ 完了  パンくずの折り返しを直す");
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    const [summary, body, link] = String(payload.embeds[0].description).split("\n");
    assert.equal(summary, "実装担当 ・ 4分12秒 ・ ツール 12件");
    // マスクしてから切り詰める (切り詰めてからでは秘密値の先頭が残る)
    assert.equal(body.includes("SECRET-TOK"), false);
    assert.match(body, /\[REDACTED\]/);
    assert.ok(body.endsWith("…"), "200 文字を超える本文は切り詰める");
    assert.equal(link, "http://127.0.0.1:5173/s/a1b2c3d4e5");
  } finally {
    db.close();
  }
});

test("a session notification is skipped when disabled or without a webhook", async () => {
  const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
  const { db, service } = createService({ fetchImpl: impl });
  try {
    const input = { sessionId: "a1", title: "t", agentName: "a", body: "b", durationMs: 1, toolCalls: 0 };
    service.notifySession(input);
    service.save({ webhookUrl: WEBHOOK, enabled: false });
    service.notifySession(input);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 0);
  } finally {
    db.close();
  }
});

test("the notifications API keeps the webhook URL write-only", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, notificationFetch: impl });
    try {
      assert.deepEqual(await jsonBody(bff.app.request("/api/notifications")), {
        enabled: false,
        provider: "discord",
        configured: false,
        mention: "none",
      });

      const rejected = await bff.app.request(
        "/api/notifications",
        jsonPut({ webhookUrl: "https://evil.example/api/webhooks/1/secret-token" }),
      );
      assert.equal(rejected.status, 400);
      const rejectedText = await rejected.text();
      assert.equal(rejectedText.includes("evil.example"), false);
      assert.equal(rejectedText.includes("secret-token"), false);

      const saved = await jsonBody(
        bff.app.request(
          "/api/notifications",
          jsonPut({ webhookUrl: WEBHOOK, enabled: true, baseUrl: "http://127.0.0.1:5173" }),
        ),
      );
      assert.equal(saved.configured, true);
      assert.equal(saved.webhookHint, "wxyz");
      assert.equal(JSON.stringify(saved).includes("discord.com/api/webhooks"), false);
      assert.equal(JSON.stringify(saved).includes("abcdefghijklmnopqrstuv"), false);

      const listed = await jsonBody(bff.app.request("/api/notifications"));
      assert.equal(JSON.stringify(listed).includes("discord.com/api/webhooks"), false);
      assert.equal(listed.baseUrl, "http://127.0.0.1:5173");

      const tested = await jsonBody(bff.app.request("/api/notifications/test", { method: "POST" }));
      assert.equal(tested.ok, true);
      assert.equal(tested.status, 204);
      assert.equal(calls.length, 1);
      assert.deepEqual((await jsonBody(bff.app.request("/api/notifications"))).lastResult, tested);

      // URL を解除すると configured が落ち、テスト送信は 400 になる
      const cleared = await jsonBody(bff.app.request("/api/notifications", jsonPut({ webhookUrl: null })));
      assert.deepEqual(cleared, {
        enabled: true,
        provider: "discord",
        configured: false,
        mention: "none",
        baseUrl: "http://127.0.0.1:5173",
      });
      assert.equal((await bff.app.request("/api/notifications/test", { method: "POST" })).status, 400);
    } finally {
      await bff.close();
    }
  });
});

test("notification settings and the last result survive a restart", async () => {
  await withStoreDir(async (dir) => {
    const { impl } = fakeFetch(
      () => new Response(JSON.stringify({ message: "Unknown Webhook", code: 10015 }), { status: 404 }),
    );
    const first = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, notificationFetch: impl });
    const tested = await (async () => {
      await first.app.request("/api/notifications", jsonPut({ webhookUrl: WEBHOOK, enabled: true, mention: "here" }));
      const result = await jsonBody(first.app.request("/api/notifications/test", { method: "POST" }));
      await first.close();
      return result as NotificationResult;
    })();

    const second = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null });
    try {
      const restored = await jsonBody(second.app.request("/api/notifications"));
      assert.equal(restored.enabled, true);
      assert.equal(restored.configured, true);
      assert.equal(restored.webhookHint, "wxyz");
      assert.equal(restored.mention, "here");
      assert.deepEqual(restored.lastResult, tested);
    } finally {
      await second.close();
    }
  });
});
