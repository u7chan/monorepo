// Cloudflare Workers の direct upload client。実 API は呼ばず、manifest → アセット送信 → deployment →
// subdomain の順序と、エラーの分類・トークン非漏洩を固定する。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CloudflareApiClient,
  CloudflareApiError,
  cloudflareAssetHash,
  type CloudflareAsset,
} from "../src/cloudflare-api";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-test-token-0123456789";
const SCRIPT = "u7s-0123456789";
const HTML = "<!doctype html><title>hello</title>";

function assetFixture(): { dir: string; asset: CloudflareAsset; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "u7agent-cf-api-"));
  const file = join(dir, "index.html");
  writeFileSync(file, HTML);
  const content = Buffer.from(HTML);
  const asset: CloudflareAsset = {
    path: "index.html",
    contentType: "text/html; charset=utf-8",
    file,
    size: content.length,
    hash: cloudflareAssetHash(content, "text/html; charset=utf-8"),
  };
  return { dir, asset, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const json = (result: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, result, errors: [], messages: [] }), {
    status,
    headers: { "content-type": "application/json" },
  });

const failure = (status: number, errors: { code: number; message: string }[]) =>
  new Response(JSON.stringify({ success: false, result: null, errors, messages: [] }), {
    status,
    headers: { "content-type": "application/json" },
  });

test("manifest → アセット → deployment → subdomain の順に送り、SPA 設定と認証を守る", async () => {
  const { asset, cleanup } = assetFixture();
  try {
    const requests: { url: URL; init: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      requests.push({ url: new URL(String(input)), init });
      switch (requests.length) {
        case 1:
          return json({ jwt: "upload-jwt", buckets: [[asset.hash]] });
        case 2:
          return json({ jwt: "completion-jwt" }, 201);
        case 3:
          return json({});
        default:
          return json({ enabled: true, previews_enabled: false });
      }
    };
    const client = new CloudflareApiClient({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl });
    await client.publishAssets(SCRIPT, [asset]);

    assert.equal(requests.length, 4);
    assert.equal(
      new URL(requests[0].url).pathname,
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/assets-upload-session`,
    );
    assert.equal(
      requests[0].init.headers && new Headers(requests[0].init.headers).get("authorization"),
      `Bearer ${TOKEN}`,
    );
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      manifest: { "/index.html": { hash: asset.hash, size: asset.size } },
    });

    assert.equal(new URL(requests[1].url).pathname, `/client/v4/accounts/${ACCOUNT}/workers/assets/upload`);
    assert.equal(new URL(requests[1].url).search, "?base64=true");
    assert.equal(new Headers(requests[1].init.headers).get("authorization"), "Bearer upload-jwt");
    const uploadForm = requests[1].init.body as FormData;
    const part = uploadForm.get(asset.hash);
    assert.ok(part instanceof Blob);
    assert.equal(part.type, "text/html; charset=utf-8");
    assert.equal(Buffer.from(await part.arrayBuffer()).toString(), Buffer.from(HTML).toString("base64"));

    assert.equal(new URL(requests[2].url).pathname, `/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}`);
    assert.equal(requests[2].init.method, "PUT");
    const deployForm = requests[2].init.body as FormData;
    const metadata = JSON.parse(String(await (deployForm.get("metadata") as Blob).text()));
    assert.deepEqual(metadata.assets, {
      jwt: "completion-jwt",
      config: { html_handling: "auto-trailing-slash", not_found_handling: "single-page-application" },
    });
    assert.equal("main_module" in metadata, false, "アセットだけの Worker に script を置かない");
    assert.equal("bindings" in metadata, false);

    assert.equal(
      new URL(requests[3].url).pathname,
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/subdomain`,
    );
    assert.deepEqual(JSON.parse(String(requests[3].init.body)), { enabled: true, previews_enabled: false });
  } finally {
    cleanup();
  }
});

test("再送不要 (buckets 空) はアセット送信を省き、manifest の JWT を完成トークンにする", async () => {
  const { asset, cleanup } = assetFixture();
  try {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      requests.push(`${init.method ?? "GET"} ${new URL(String(input)).pathname}`);
      if (requests.length === 1) return json({ jwt: "upload-jwt", buckets: [] });
      if (requests.length === 2) return json({});
      return json({ enabled: true, previews_enabled: false });
    };
    const client = new CloudflareApiClient({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl });
    await client.publishAssets(SCRIPT, [asset]);
    assert.equal(
      requests.some((line) => line.includes("/workers/assets/upload")),
      false,
    );
    const deploy = requests[1];
    assert.match(deploy, /^PUT /);
  } finally {
    cleanup();
  }
});

test("アカウント / script の subdomain を読む", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(new URL(String(input)).pathname);
    if (calls.length === 1) return json({ subdomain: "demo" });
    return json({ enabled: true, previews_enabled: false });
  };
  const client = new CloudflareApiClient({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl });
  assert.equal(await client.getAccountSubdomain(), "demo");
  assert.deepEqual(await client.getScriptSubdomain(SCRIPT), { enabled: true, previewsEnabled: false });
});

test("エラーは分類だけを返し、応答本文とトークンを message に載せない", async () => {
  const cases: {
    status: number;
    body: unknown;
    kind: string;
  }[] = [
    { status: 401, body: { success: false, errors: [{ code: 10000, message: "auth" }] }, kind: "unauthorized" },
    { status: 404, body: { success: false, errors: [{ code: 10007, message: "not found" }] }, kind: "not_found" },
    { status: 429, body: { success: false, errors: [{ code: 10001, message: "slow down" }] }, kind: "rate_limited" },
    {
      status: 403,
      body: { success: false, errors: [{ code: 10002, message: "workers limit exceeded" }] },
      kind: "quota",
    },
    { status: 500, body: { success: false, errors: [{ code: 10003, message: "boom" }] }, kind: "transient" },
    { status: 400, body: { success: false, errors: [{ code: 10004, message: "bad request" }] }, kind: "invalid" },
  ];
  for (const entry of cases) {
    const body = entry.body as { errors: { code: number; message: string }[] };
    const fetchImpl: typeof fetch = async () => failure(entry.status, body.errors);
    const client = new CloudflareApiClient({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl });
    await assert.rejects(
      () => client.getScriptSubdomain(SCRIPT),
      (error: unknown) => {
        assert.ok(error instanceof CloudflareApiError);
        assert.equal(error.kind, entry.kind);
        assert.equal(error.message.includes(TOKEN), false);
        assert.equal(error.message.includes("bad request"), false);
        return true;
      },
    );
  }
});

test("timeout と network を分け、AbortSignal の name に依存しすぎない", async () => {
  const timeoutFetch: typeof fetch = async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  };
  await assert.rejects(
    () =>
      new CloudflareApiClient({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl: timeoutFetch }).getAccountSubdomain(),
    (error: unknown) => error instanceof CloudflareApiError && error.kind === "timeout",
  );
  const networkFetch: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () =>
      new CloudflareApiClient({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl: networkFetch }).getAccountSubdomain(),
    (error: unknown) => error instanceof CloudflareApiError && error.kind === "network",
  );
});
