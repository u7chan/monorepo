// 設定 → 共有 → 接続 の下書き規則。保存済みトークンを再表示しないため、空のトークンは送らない。
import assert from "node:assert/strict";
import test from "node:test";
import {
  cloudflareCheckDisplay,
  cloudflareCheckEnabled,
  cloudflareDeleteConfirmRequest,
  cloudflareDraftDirty,
  cloudflareDraftFromSettings,
  cloudflareHttpStatusLabel,
  cloudflareSaveBody,
  type CloudflareCheckEnableInput,
} from "../src/lib/cloudflareSettings";
import { messageFullTimeLabel, messageTimeLabel } from "../src/lib/messageTime";
import type { CloudflareConnectionCheckResponse, CloudflareSettingsResponse } from "../src/types";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

const settings = (overrides: Partial<CloudflareSettingsResponse> = {}): CloudflareSettingsResponse => ({
  configured: true,
  accountId: ACCOUNT,
  available: true,
  unavailableReason: null,
  ...overrides,
});

const checkResult = (
  overrides: Partial<CloudflareConnectionCheckResponse> = {},
): CloudflareConnectionCheckResponse => ({
  checkedAt: Date.parse("2026-09-05T03:04:05.000Z"),
  accountId: ACCOUNT,
  subdomain: null,
  failure: null,
  httpStatus: null,
  message: null,
  ...overrides,
});

test("下書きは保存済みアカウント ID から始まり、トークンは常に空", () => {
  assert.deepEqual(cloudflareDraftFromSettings(null), { accountId: "", apiToken: "" });
  assert.deepEqual(cloudflareDraftFromSettings(settings()), { accountId: ACCOUNT, apiToken: "" });
});

test("アカウント ID の大文字小文字だけでは dirty にせず、トークンの入力で dirty にする", () => {
  const draft = cloudflareDraftFromSettings(settings());
  assert.equal(cloudflareDraftDirty(draft, settings()), false);
  assert.equal(cloudflareDraftDirty({ ...draft, accountId: ACCOUNT.toUpperCase() }, settings()), false);
  assert.equal(cloudflareDraftDirty({ ...draft, accountId: ACCOUNT.slice(1) }, settings()), true);
  assert.equal(cloudflareDraftDirty({ ...draft, apiToken: "new-token" }, settings()), true);
  assert.equal(cloudflareDraftDirty({ ...draft, accountId: " " }, settings()), true);
});

test("保存要求は空のトークンを送らず、値は trim する", () => {
  assert.deepEqual(cloudflareSaveBody({ accountId: ` ${ACCOUNT} `, apiToken: " " }), { accountId: ACCOUNT });
  assert.deepEqual(cloudflareSaveBody({ accountId: ACCOUNT, apiToken: " token " }), {
    accountId: ACCOUNT,
    apiToken: "token",
  });
});

test("削除の確認は対象と影響（再登録が必要・共有物は消えない）を明示する", () => {
  const request = cloudflareDeleteConfirmRequest();
  assert.equal(request.kind, "confirm");
  assert.equal(request.danger, true);
  assert.equal(request.confirmLabel, "削除する");
  assert.match(request.body?.join("\n") ?? "", /再登録/);
  assert.match(request.body?.join("\n") ?? "", /共有コンテンツは削除されません/);
});

const saveInput: Omit<CloudflareCheckEnableInput, "settings"> = {
  dirty: false,
  saving: null,
  reloading: false,
  checking: false,
};

test("接続を確認は、未登録 / master key 不在 / 未保存の下書き / 進行中の操作では押せない", () => {
  const enabled = (settings: CloudflareSettingsResponse, input: Partial<typeof saveInput> = {}) =>
    cloudflareCheckEnabled({ settings, ...saveInput, ...input });
  assert.equal(enabled(settings()), true);
  assert.equal(enabled(settings({ configured: false, accountId: null })), false);
  assert.equal(enabled(settings({ available: false })), false);
  assert.equal(enabled(settings(), { dirty: true }), false);
  assert.equal(enabled(settings(), { saving: "save" }), false);
  assert.equal(enabled(settings(), { saving: "delete" }), false);
  assert.equal(enabled(settings(), { reloading: true }), false);
  assert.equal(enabled(settings(), { checking: true }), false);
});

test("結果行は下書きが保存値と違う間と、アカウント ID が食い違う結果では出さない", () => {
  const display = (input: Partial<Parameters<typeof cloudflareCheckDisplay>[0]>) =>
    cloudflareCheckDisplay({
      settings: settings(),
      dirty: false,
      checking: false,
      result: checkResult({ subdomain: "demo" }),
      error: null,
      ...input,
    });
  assert.equal(display({ dirty: true }), null, "前回値の結果を今の入力の結果に見せない");
  assert.equal(display({ result: checkResult({ subdomain: "demo", accountId: "other" }) }), null);
  assert.equal(display({ result: null }), null);
});

test("確認中は古い結果ではなく進行中の 1 行を出し、409 / 503 は失敗の文を出す", () => {
  assert.deepEqual(
    cloudflareCheckDisplay({
      settings: settings(),
      dirty: false,
      checking: true,
      result: null,
      error: null,
    }),
    { kind: "pending", message: "接続を確認しています" },
  );
  assert.deepEqual(
    cloudflareCheckDisplay({
      settings: settings(),
      dirty: false,
      checking: false,
      result: null,
      error: "Cloudflare の資格情報が未登録です",
    }),
    { kind: "error", message: "Cloudflare の資格情報が未登録です" },
  );
});

test("成功はサブドメインと確認時刻を出し、失敗は固定文言に HTTP status を添える", () => {
  const checkedAt = Date.parse("2026-09-05T03:04:05.000Z");
  const success = cloudflareCheckDisplay({
    settings: settings(),
    dirty: false,
    checking: false,
    result: checkResult({ checkedAt, subdomain: "demo" }),
    error: null,
    now: checkedAt,
  });
  assert.ok(success && success.kind === "success");
  assert.match(success.message, /demo\.workers\.dev/);
  assert.equal(success.time, messageTimeLabel(checkedAt, { now: checkedAt }));
  assert.equal(success.fullTime, messageFullTimeLabel(checkedAt));
  assert.match(success.fullTime, /^\d{4}\/\d{1,2}\/\d{1,2}\(.\) \d{2}:\d{2}$/);

  const failure = cloudflareCheckDisplay({
    settings: settings(),
    dirty: false,
    checking: false,
    result: checkResult({ failure: "unauthorized", httpStatus: 401, message: "トークンが拒否されました" }),
    error: null,
  });
  assert.deepEqual(failure, { kind: "failure", message: "トークンが拒否されました", httpStatus: "HTTP 401" });
});

test("HTTP status は 400 以上のときだけ添える", () => {
  assert.equal(cloudflareHttpStatusLabel(401), "HTTP 401");
  assert.equal(cloudflareHttpStatusLabel(400), "HTTP 400");
  assert.equal(cloudflareHttpStatusLabel(200), null, "unverifiable の 200 を失敗行に出さない");
  assert.equal(cloudflareHttpStatusLabel(null), null);
});
