// 設定 → 共有 → 接続 の下書き規則。保存済みトークンを再表示しないため、空のトークンは送らない。
import assert from "node:assert/strict";
import test from "node:test";
import {
  cloudflareDeleteConfirmRequest,
  cloudflareDraftDirty,
  cloudflareDraftFromSettings,
  cloudflareSaveBody,
} from "../src/lib/cloudflareSettings";
import type { CloudflareSettingsResponse } from "../src/types";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

const settings = (overrides: Partial<CloudflareSettingsResponse> = {}): CloudflareSettingsResponse => ({
  configured: true,
  accountId: ACCOUNT,
  available: true,
  unavailableReason: null,
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
