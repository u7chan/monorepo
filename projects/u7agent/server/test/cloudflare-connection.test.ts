// 接続確認の分類。保存済みの資格情報で subdomain GET を 1 本だけ呼び、Cloudflare の失敗を
// 接続確認向けの固定文言と 400 以上の httpStatus へ写すことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { CloudflareApiError, SHARED_CONTENT_NO_SUBDOMAIN, type CloudflareFailureKind } from "../src/cloudflare-api";
import { CloudflareConnectionService } from "../src/cloudflare-connection";
import { SHARED_CONTENT_NO_CREDENTIALS } from "../src/cloudflare-settings";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-test-token-0123456789";

function service(
  getAccountSubdomain: () => Promise<string>,
  options: { credential?: () => { accountId: string; apiToken: string } | null; now?: () => number } = {},
) {
  const created: { accountId: string; apiToken: string }[] = [];
  const instance = new CloudflareConnectionService({
    credentials: {
      credential: options.credential ?? (() => ({ accountId: ACCOUNT, apiToken: TOKEN })),
    },
    createCloudflare: (credential) => {
      created.push(credential);
      return { getAccountSubdomain };
    },
    now: options.now ?? (() => 1_730_000_000_000),
  });
  return { instance, created };
}

async function checkFailure(kind: CloudflareFailureKind, status?: number) {
  const { instance } = service(async () => {
    throw new CloudflareApiError(kind, status);
  });
  return instance.check();
}

test("成功は subdomain を返し、失敗の欄をすべて null にする", async () => {
  const { instance, created } = service(async () => "demo");
  const result = await instance.check();
  assert.deepEqual(result, {
    checkedAt: 1_730_000_000_000,
    accountId: ACCOUNT,
    subdomain: "demo",
    failure: null,
    httpStatus: null,
    message: null,
  });
  // 確認も公開と同じ factory を通す (保存済みの資格情報をそのまま渡す)
  assert.deepEqual(created, [{ accountId: ACCOUNT, apiToken: TOKEN }]);
});

test("checkedAt は注入した時計で固定できる", async () => {
  const { instance } = service(async () => "demo", { now: () => 42 });
  assert.equal((await instance.check()).checkedAt, 42);
});

test("空の subdomain は workers.dev 未有効として失敗にし、httpStatus を付けない", async () => {
  const { instance } = service(async () => "");
  const result = await instance.check();
  assert.equal(result.failure, "no_subdomain");
  assert.equal(result.subdomain, null);
  assert.equal(result.httpStatus, null);
  assert.equal(result.message, SHARED_CONTENT_NO_SUBDOMAIN);
});

test("401 はトークンの拒否として HTTP 401 を添える", async () => {
  const result = await checkFailure("unauthorized", 401);
  assert.equal(result.failure, "unauthorized");
  assert.equal(result.httpStatus, 401);
  assert.equal(result.subdomain, null);
  assert.match(result.message ?? "", /API トークン/);
  assert.equal((result.message ?? "").includes(TOKEN), false);
});

test("403 はアカウント ID と権限の確認へ寄せ、401 と文言を分ける", async () => {
  const unauthorized = await checkFailure("unauthorized", 401);
  const forbidden = await checkFailure("unauthorized", 403);
  assert.equal(forbidden.failure, "unauthorized");
  assert.equal(forbidden.httpStatus, 403);
  assert.match(forbidden.message ?? "", /アカウント ID/);
  assert.match(forbidden.message ?? "", /Workers Scripts/);
  assert.notEqual(forbidden.message, unauthorized.message);
});

test("404 はアカウント ID と workers.dev の確認へ寄せ、公開向けの Worker 文言を出さない", async () => {
  const result = await checkFailure("not_found", 404);
  assert.equal(result.failure, "not_found");
  assert.equal(result.httpStatus, 404);
  assert.match(result.message ?? "", /アカウント ID/);
  assert.match(result.message ?? "", /workers\.dev/);
  assert.equal((result.message ?? "").includes("Worker が見つかりません"), false);
});

test("invalid は公開要求ではなく接続確認の要求として説明する", async () => {
  const result = await checkFailure("invalid", 400);
  assert.equal(result.failure, "invalid");
  assert.equal(result.httpStatus, 400);
  assert.match(result.message ?? "", /接続確認/);
  assert.equal((result.message ?? "").includes("公開要求"), false);
});

test("quota / rate_limited / transient も接続確認向けの文言を持つ", async () => {
  const quota = await checkFailure("quota", 403);
  assert.equal(quota.httpStatus, 403);
  assert.match(quota.message ?? "", /枠/);

  const rateLimited = await checkFailure("rate_limited", 429);
  assert.equal(rateLimited.httpStatus, 429);
  assert.match(rateLimited.message ?? "", /混み合って/);

  const transient = await checkFailure("transient", 503);
  assert.equal(transient.httpStatus, 503);
  assert.match(transient.message ?? "", /一時的なエラー/);
});

test("timeout / network は httpStatus を持たない", async () => {
  const timeout = await checkFailure("timeout");
  assert.equal(timeout.failure, "timeout");
  assert.equal(timeout.httpStatus, null);
  assert.match(timeout.message ?? "", /タイムアウト/);

  const network = await checkFailure("network");
  assert.equal(network.failure, "network");
  assert.equal(network.httpStatus, null);
  assert.match(network.message ?? "", /接続できません/);
});

test("unverifiable が 200 を持っていても、失敗行に HTTP 200 を出さない", async () => {
  const result = await checkFailure("unverifiable", 200);
  assert.equal(result.failure, "unverifiable");
  assert.equal(result.httpStatus, null);
  assert.match(result.message ?? "", /応答を確認できません/);
});

test("未登録は 409、master key 不在・復号不可は 503 のまま外へ出し、200 の失敗に写さない", async () => {
  const notStored = service(async () => "demo", { credential: () => null });
  await assert.rejects(
    () => notStored.instance.check(),
    (error: any) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, SHARED_CONTENT_NO_CREDENTIALS);
      return true;
    },
  );
  assert.deepEqual(notStored.created, [], "未登録では Cloudflare を呼ばない");

  const unavailable = service(async () => "demo", {
    credential: () => {
      const error = new Error("master key unavailable");
      (error as { statusCode?: number }).statusCode = 503;
      throw error;
    },
  });
  await assert.rejects(
    () => unavailable.instance.check(),
    (error: any) => error.statusCode === 503,
  );
  assert.deepEqual(unavailable.created, [], "復号できないときも Cloudflare を呼ばない");
});

test("応答の不変条件: 成功は subdomain が非空で message / httpStatus が null、失敗は subdomain が null で message が非 null", async () => {
  const results = [
    await service(async () => "demo").instance.check(),
    await service(async () => "").instance.check(),
    await checkFailure("unauthorized", 401),
    await checkFailure("unauthorized", 403),
    await checkFailure("not_found", 404),
    await checkFailure("timeout"),
  ];
  for (const result of results) {
    assert.equal(typeof result.checkedAt, "number");
    assert.equal(result.accountId, ACCOUNT);
    if (result.failure === null) {
      assert.ok(result.subdomain, "成功は subdomain を持つ");
      assert.equal(result.message, null);
      assert.equal(result.httpStatus, null);
    } else {
      assert.equal(result.subdomain, null);
      assert.ok(result.message, "失敗は固定文言を持つ");
    }
  }
});
