// Cloudflare 資格情報の HTTP 契約。トークンが応答・error・マスク前のログ経路へ出ないこと、
// 省略更新で維持されること、master key 不在時に 503 で止まることを実アプリで検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { SECRET_KEY_BYTES, SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import { asPiBff, createStubPi } from "./stub-pi";

const KEY = `1:${Buffer.alloc(SECRET_KEY_BYTES, 7).toString("base64")}`;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
const TOKEN = `cf-${"b".repeat(37)}`;

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

async function setup(options: { masterKey?: boolean; cloudflareFetch?: typeof fetch } = {}) {
  const previous = process.env[SECRET_MASTER_KEY_ENV];
  if (options.masterKey === false) delete process.env[SECRET_MASTER_KEY_ENV];
  else process.env[SECRET_MASTER_KEY_ENV] = KEY;
  const pi = createStubPi();
  const bff = await createBffApp({
    cwd: "/workspace",
    sessionStoreDir: null,
    pi: asPiBff(pi),
    workspace: null,
    ...(options.cloudflareFetch ? { cloudflareFetch: options.cloudflareFetch } : {}),
  });
  return {
    bff,
    pi,
    restore: () => {
      if (previous === undefined) delete process.env[SECRET_MASTER_KEY_ENV];
      else process.env[SECRET_MASTER_KEY_ENV] = previous;
    },
  };
}

test("PUT → GET → PUT（トークン省略）→ DELETE の往復で、トークンは応答に載らない", async () => {
  const { bff, pi, restore } = await setup();
  try {
    const before = await jsonBody(await bff.app.request("/api/settings/cloudflare"));
    assert.deepEqual(before, {
      configured: false,
      accountId: null,
      available: true,
      unavailableReason: null,
    });

    const put = await bff.app.request(
      "/api/settings/cloudflare",
      jsonPut({ accountId: ACCOUNT.toUpperCase(), apiToken: ` ${TOKEN} ` }),
    );
    assert.equal(put.status, 200);
    const putBody = await jsonBody(put);
    assert.equal(putBody.configured, true);
    assert.equal(putBody.accountId, ACCOUNT);
    assert.equal(putBody.state, "applied");
    assert.equal(JSON.stringify(putBody).includes(TOKEN), false, "応答にトークンを載せない");

    const row = bff.appDb.readCloudflareSettings();
    assert.ok(row);
    assert.equal(Buffer.from(row.ciphertext).toString("utf8").includes(TOKEN), false, "暗号文に平文を残さない");
    assert.deepEqual(bff.cloudflareSettings.credential(), { accountId: ACCOUNT, apiToken: TOKEN });
    assert.notEqual(pi.secretMasker.mask(TOKEN), TOKEN, "ログ / 例外用のマスク対象へ登録する");

    const got = await bff.app.request("/api/settings/cloudflare");
    const gotText = await got.text();
    assert.equal(gotText.includes(TOKEN), false, "GET にトークンを載せない");

    // トークンを省略した更新は保存済みの暗号文を維持する
    const updated = await jsonBody(
      await bff.app.request("/api/settings/cloudflare", jsonPut({ accountId: OTHER_ACCOUNT })),
    );
    assert.equal(updated.accountId, OTHER_ACCOUNT);
    assert.deepEqual(bff.cloudflareSettings.credential(), { accountId: OTHER_ACCOUNT, apiToken: TOKEN });

    const deleted = await jsonBody(await bff.app.request("/api/settings/cloudflare", { method: "DELETE" }));
    assert.equal(deleted.configured, false);
    assert.equal(deleted.accountId, null);
    assert.equal(bff.cloudflareSettings.credential(), null);
    assert.equal(bff.appDb.readCloudflareSettings(), undefined);
    assert.equal(
      (await jsonBody(await bff.app.request("/api/settings/cloudflare", { method: "DELETE" }))).configured,
      false,
    );
  } finally {
    restore();
  }
});

test("形式不正は 400、初回のトークン省略は 400 で、値は error に載らない", async () => {
  const { bff, restore } = await setup();
  try {
    const missing = await bff.app.request("/api/settings/cloudflare", jsonPut({ accountId: ACCOUNT }));
    assert.equal(missing.status, 400);
    const missingText = await missing.text();
    assert.equal(missingText.includes(TOKEN), false);
    assert.match(missingText, /API トークン/);

    const malformed = await bff.app.request(
      "/api/settings/cloudflare",
      jsonPut({ accountId: "not-an-account", apiToken: TOKEN }),
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.text()).includes(TOKEN), false);

    const invalidBody = await bff.app.request("/api/settings/cloudflare", jsonPut({ apiToken: TOKEN }));
    assert.equal(invalidBody.status, 400);
    assert.equal((await invalidBody.text()).includes(TOKEN), false);
  } finally {
    restore();
  }
});

test("master key が無いときは GET で理由を返し、PUT は 503 で何も保存しない", async () => {
  const { bff, restore } = await setup({ masterKey: false });
  try {
    const before = await jsonBody(await bff.app.request("/api/settings/cloudflare"));
    assert.equal(before.configured, false);
    assert.equal(before.available, false);
    assert.match(before.unavailableReason, /master key/);

    const put = await bff.app.request("/api/settings/cloudflare", jsonPut({ accountId: ACCOUNT, apiToken: TOKEN }));
    assert.equal(put.status, 503);
    const body = await jsonBody(put);
    assert.equal(body.state, "not_stored");
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
    assert.equal(bff.appDb.readCloudflareSettings(), undefined);
    assert.equal(bff.cloudflareSettings.credential(), null);
  } finally {
    restore();
  }
});

test("保存後に master key なしで再起動しても、トークン省略 PUT は 503 で既存値を変えない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-cloudflare-"));
  const previous = process.env[SECRET_MASTER_KEY_ENV];
  try {
    process.env[SECRET_MASTER_KEY_ENV] = KEY;
    const first = await createBffApp({
      cwd: "/workspace",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    assert.equal(
      (await first.app.request("/api/settings/cloudflare", jsonPut({ accountId: ACCOUNT, apiToken: TOKEN }))).status,
      200,
    );
    await first.close();

    delete process.env[SECRET_MASTER_KEY_ENV];
    const second = await createBffApp({
      cwd: "/workspace",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      const before = await jsonBody(await second.app.request("/api/settings/cloudflare"));
      assert.equal(before.configured, true);
      assert.equal(before.accountId, ACCOUNT);
      assert.equal(before.available, false);

      const put = await second.app.request("/api/settings/cloudflare", jsonPut({ accountId: OTHER_ACCOUNT }));
      assert.equal(put.status, 503);
      assert.equal((await jsonBody(put)).state, "not_stored");

      const after = await jsonBody(await second.app.request("/api/settings/cloudflare"));
      assert.equal(after.accountId, ACCOUNT, "鍵が無い更新でアカウント ID を変えない");
    } finally {
      await second.close();
    }
  } finally {
    if (previous === undefined) delete process.env[SECRET_MASTER_KEY_ENV];
    else process.env[SECRET_MASTER_KEY_ENV] = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("接続確認は保存済みトークンで subdomain を 1 本だけ問い合わせ、応答にトークンを載せない", async () => {
  const calls: { url: string; method: string; authorization: string | null }[] = [];
  const { bff, restore } = await setup({
    cloudflareFetch: async (input, init = {}) => {
      calls.push({
        url: String(input),
        method: init.method ?? "GET",
        authorization: new Headers(init.headers).get("Authorization"),
      });
      return Response.json({ success: true, result: { subdomain: "demo" }, errors: [], messages: [] });
    },
  });
  try {
    assert.equal(
      (await bff.app.request("/api/settings/cloudflare", jsonPut({ accountId: ACCOUNT, apiToken: TOKEN }))).status,
      200,
    );
    const response = await bff.app.request("/api/settings/cloudflare/check", { method: "POST" });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(TOKEN), false, "応答にトークンを載せない");
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), [
      "accountId",
      "checkedAt",
      "failure",
      "httpStatus",
      "message",
      "subdomain",
    ]);
    assert.equal(body.accountId, ACCOUNT);
    assert.equal(body.subdomain, "demo");
    assert.equal(body.failure, null);
    assert.equal(body.httpStatus, null);
    assert.equal(body.message, null);
    assert.equal(typeof body.checkedAt, "number");

    assert.equal(calls.length, 1, "subdomain GET は 1 本だけ");
    assert.equal(calls[0].method, "GET");
    assert.equal(new URL(calls[0].url).pathname, `/client/v4/accounts/${ACCOUNT}/workers/subdomain`);
    assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
  } finally {
    restore();
  }
});

test("接続確認の 409（未登録）は state を付けず、外部通信もしない", async () => {
  const calls: string[] = [];
  const unreachable: typeof fetch = async (input) => {
    calls.push(String(input));
    throw new Error("未登録では Cloudflare を呼ばない");
  };
  const { bff, restore } = await setup({ cloudflareFetch: unreachable });
  try {
    const response = await bff.app.request("/api/settings/cloudflare/check", { method: "POST" });
    assert.equal(response.status, 409);
    const body = await jsonBody(response);
    assert.match(body.error, /資格情報が未登録/);
    assert.equal("state" in body, false, "保存しない操作に state を付けない");
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test("接続確認の 503（復号不可）は state を付けず、200 の failure に化けない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-cloudflare-check-"));
  const previous = process.env[SECRET_MASTER_KEY_ENV];
  const calls: string[] = [];
  const unreachable: typeof fetch = async (input) => {
    calls.push(String(input));
    throw new Error("復号できないときは Cloudflare を呼ばない");
  };
  try {
    process.env[SECRET_MASTER_KEY_ENV] = KEY;
    const first = await createBffApp({
      cwd: "/workspace",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      cloudflareFetch: unreachable,
    });
    assert.equal(
      (await first.app.request("/api/settings/cloudflare", jsonPut({ accountId: ACCOUNT, apiToken: TOKEN }))).status,
      200,
    );
    await first.close();

    delete process.env[SECRET_MASTER_KEY_ENV];
    const second = await createBffApp({
      cwd: "/workspace",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      cloudflareFetch: unreachable,
    });
    try {
      const response = await second.app.request("/api/settings/cloudflare/check", { method: "POST" });
      assert.equal(response.status, 503);
      const body = await jsonBody(response);
      assert.match(body.error, /master key/);
      assert.equal("state" in body, false, "復号できない 503 を not_stored にしない");
      assert.equal("failure" in body, false, "503 を 200 の failure に写さない");
      assert.deepEqual(calls, []);
    } finally {
      await second.close();
    }
  } finally {
    if (previous === undefined) delete process.env[SECRET_MASTER_KEY_ENV];
    else process.env[SECRET_MASTER_KEY_ENV] = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/settings/cloudflare は外部通信しない", async () => {
  const calls: string[] = [];
  const { bff, restore } = await setup({
    cloudflareFetch: async (input) => {
      calls.push(String(input));
      throw new Error("設定の GET は外部通信しない");
    },
  });
  try {
    assert.equal(
      (await bff.app.request("/api/settings/cloudflare", jsonPut({ accountId: ACCOUNT, apiToken: TOKEN }))).status,
      200,
    );
    assert.equal((await bff.app.request("/api/settings/cloudflare")).status, 200);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});
