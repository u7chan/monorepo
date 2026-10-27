// アプリ DB のキー / Webhook URL を暗号化しても、master key 未設定でアプリの起動と
// env / auth.json のプロバイダー認証が止まらないことを見る。
import assert from "node:assert/strict";
import test from "node:test";
import { createBffApp } from "../src/app";
import { APP_SECRET_MASTER_KEY_MESSAGE } from "../src/app-secrets";
import { SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import { asPiBff, createStubPi } from "./stub-pi";

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

test("master key 未設定でも起動し、DB 保存キーを使う機能だけが未設定 / 503 になる", async () => {
  const previous = process.env[SECRET_MASTER_KEY_ENV];
  delete process.env[SECRET_MASTER_KEY_ENV];
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: asPiBff(createStubPi({ providers: [{ provider: "anthropic", name: "Anthropic", configured: true }] })),
    workspace: null,
  });
  try {
    // アプリの DB と設定画面は開ける
    const health = await jsonBody(await bff.app.request("/api/health"));
    assert.equal(health.appDb.ok, true);

    // env で認証しているプロバイダーは今までどおり見える (DB 保存キーだけが使えない)
    const models = await jsonBody(await bff.app.request("/api/settings/models"));
    assert.equal(models.runtimeAvailable, true);
    const anthropic = models.providers.find((provider: any) => provider.provider === "anthropic");
    assert.equal(anthropic.auth.source, "environment", "env / auth.json の認証は影響を受けない");

    const content = await jsonBody(await bff.app.request("/api/settings/content"));
    assert.equal(content.keyStored, false);
    assert.equal(content.keyAvailable, false);

    // 新規保存は暗号化できないので 503 (平文で保存しない)
    const put = await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: "sk-image-dummy-0123456789" }));
    assert.equal(put.status, 503);
    const body = await jsonBody(put);
    assert.equal(body.state, "not_stored");

    const notifications = await jsonBody(await bff.app.request("/api/notifications"));
    assert.equal(notifications.configured, false);
    assert.equal(notifications.webhookEvaluated, true);
  } finally {
    await bff.close();
    if (previous === undefined) delete process.env[SECRET_MASTER_KEY_ENV];
    else process.env[SECRET_MASTER_KEY_ENV] = previous;
  }
});

test("master key の宣言が壊れていても起動し、固定文言で理由を示す", async () => {
  const previous = process.env[SECRET_MASTER_KEY_ENV];
  process.env[SECRET_MASTER_KEY_ENV] = "broken";
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: asPiBff(createStubPi({ providers: [{ provider: "anthropic", name: "Anthropic", configured: true }] })),
    workspace: null,
  });
  try {
    const put = await bff.app.request(
      "/api/settings/models/anthropic/key",
      jsonPut({ apiKey: "sk-ant-dummy-0123456789" }),
    );
    assert.equal(put.status, 503, "壊れた宣言ではキーを保存しない");
    // 文言には master key の値も断片も出さない
    const body = await jsonBody(put);
    assert.equal(JSON.stringify(body).includes("broken"), false);
    assert.equal(typeof APP_SECRET_MASTER_KEY_MESSAGE, "string");
  } finally {
    await bff.close();
    if (previous === undefined) delete process.env[SECRET_MASTER_KEY_ENV];
    else process.env[SECRET_MASTER_KEY_ENV] = previous;
  }
});
