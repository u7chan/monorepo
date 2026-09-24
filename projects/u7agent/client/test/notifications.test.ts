// 通知設定の下書き → PUT body、テスト結果の文言、プレビュー本文の固定。DOM を使わない純ロジックだけを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  draftBody,
  draftFromSettings,
  draftIsDirty,
  EMPTY_NOTIFICATION_DRAFT,
  httpStatusLabel,
  notificationHasFailure,
  notificationPreviewLines,
  notificationResultView,
  previewLink,
  resultMetaLabel,
  resultTimeLabel,
  syncDraft,
  testAvailable,
  testNeedsSave,
} from "../src/lib/notifications";
import type { NotificationResult, NotificationsResponse } from "../src/types";

const SETTINGS: NotificationsResponse = {
  enabled: true,
  provider: "discord",
  configured: true,
  webhookHint: "a1b2",
  baseUrl: "http://127.0.0.1:5173",
  mention: "none",
};

const TIME_ZONE = "Asia/Tokyo";

test("draftFromSettings は保存済みの値から下書きを作り、URL は常に空から始める", () => {
  assert.deepEqual(draftFromSettings(SETTINGS), {
    enabled: true,
    webhookUrl: null,
    baseUrl: "http://127.0.0.1:5173",
    mention: "none",
  });
  assert.deepEqual(draftFromSettings(null), EMPTY_NOTIFICATION_DRAFT);
});

test("draftIsDirty は enabled / URL の入力開始 / baseUrl / mention の差だけを見る", () => {
  const base = draftFromSettings(SETTINGS);
  assert.equal(draftIsDirty(base, SETTINGS), false);
  assert.equal(draftIsDirty(base, null), false);
  assert.equal(draftIsDirty({ ...base, enabled: false }, SETTINGS), true);
  assert.equal(draftIsDirty({ ...base, webhookUrl: "" }, SETTINGS), true);
  assert.equal(draftIsDirty({ ...base, baseUrl: "http://127.0.0.1:5174" }, SETTINGS), true);
  assert.equal(draftIsDirty({ ...base, mention: "here" }, SETTINGS), true);
  // 前後の空白は保存時に落ちるため、変わっていない扱いにする
  assert.equal(draftIsDirty({ ...base, baseUrl: `  ${SETTINGS.baseUrl}  ` }, SETTINGS), false);
});

test("draftBody は URL を触っていなければ送らず、空の baseUrl は null (解除) にする", () => {
  const base = draftFromSettings(SETTINGS);
  assert.deepEqual(draftBody(base), { enabled: true, mention: "none", baseUrl: "http://127.0.0.1:5173" });
  assert.deepEqual(draftBody({ ...base, webhookUrl: "https://discord.com/api/webhooks/1/token" }), {
    enabled: true,
    mention: "none",
    baseUrl: "http://127.0.0.1:5173",
    webhookUrl: "https://discord.com/api/webhooks/1/token",
  });
  assert.equal(draftBody({ ...base, webhookUrl: "  " }).webhookUrl, null);
  assert.equal(draftBody({ ...base, baseUrl: "" }).baseUrl, null);
  assert.equal(
    draftBody({ ...base, webhookUrl: "  https://discord.com/api/webhooks/1/token  " }).webhookUrl,
    "https://discord.com/api/webhooks/1/token",
  );
});

test("syncDraft は未編集のフィールドだけ新しい保存値へ追従させる", () => {
  const base = draftFromSettings(SETTINGS);
  // 他タブの保存で enabled / baseUrl / mention が変わっても、A の未編集の下書きは追従する
  const next: NotificationsResponse = {
    ...SETTINGS,
    enabled: false,
    baseUrl: "http://127.0.0.1:5174",
    mention: "here",
  };
  const synced = syncDraft(base, SETTINGS, next);
  assert.deepEqual(synced, { enabled: false, webhookUrl: null, baseUrl: "http://127.0.0.1:5174", mention: "here" });
  // 追従後の下書きは保存済みと同じなので、古い値を PUT しない (dirty が立たない)
  assert.equal(draftIsDirty(synced, next), false);

  // 未編集のフィールドは追従し、編集中のフィールドは残る (同じ下書き内で混ざってもよい)
  const edited = { ...base, enabled: true, baseUrl: "http://127.0.0.1:5175", mention: "none" as const };
  const kept = syncDraft(edited, SETTINGS, next);
  assert.deepEqual(kept, { enabled: false, webhookUrl: null, baseUrl: "http://127.0.0.1:5175", mention: "here" });
  // baseUrl の編集だけが残るため dirty は立つ (保存すればその値が送られる)
  assert.equal(draftIsDirty(kept, next), true);

  // 前後の空白だけの差は未編集として扱う
  assert.equal(syncDraft({ ...base, baseUrl: "  http://127.0.0.1:5173  " }, SETTINGS, next).baseUrl, next.baseUrl);
  // 初回 (直前の保存値が無い) は保存値から作る
  assert.deepEqual(syncDraft(EMPTY_NOTIFICATION_DRAFT, null, next), draftFromSettings(next));
});

test("syncDraft は「変更」で入力中の Webhook URL を残す", () => {
  const base = draftFromSettings(SETTINGS);
  const next: NotificationsResponse = { ...SETTINGS, configured: false, webhookHint: undefined };
  const synced = syncDraft({ ...base, webhookUrl: "https://discord.com/api/webhooks/1/token" }, SETTINGS, next);
  assert.equal(synced.webhookUrl, "https://discord.com/api/webhooks/1/token");
  assert.equal(synced.enabled, next.enabled);
  // 未編集 (null) は null のまま。他タブの保存で入力欄が勝手に開かない
  assert.equal(syncDraft(base, SETTINGS, next).webhookUrl, null);
});

test("テスト送信の可否は保存後の URL の有無で決める", () => {
  const base = draftFromSettings(SETTINGS);
  assert.equal(testNeedsSave(base), false);
  assert.equal(testNeedsSave({ ...base, webhookUrl: "https://discord.com/api/webhooks/1/token" }), true);
  // 解除の入力は「保存してテスト」にしない (保存後は送り先が無い)
  assert.equal(testNeedsSave({ ...base, webhookUrl: "  " }), false);

  assert.equal(testAvailable(base, SETTINGS), true);
  assert.equal(testAvailable(base, { ...SETTINGS, configured: false, webhookHint: undefined }), false);
  assert.equal(testAvailable({ ...base, webhookUrl: "https://discord.com/api/webhooks/1/token" }, SETTINGS), true);
  assert.equal(testAvailable({ ...base, webhookUrl: "" }, SETTINGS), false);
  assert.equal(testAvailable(base, null), false);
});

test("ナビの ⚠ は直近の送信が失敗しているときだけ出す", () => {
  assert.equal(notificationHasFailure(null), false);
  assert.equal(notificationHasFailure(SETTINGS), false);
  assert.equal(notificationHasFailure({ ...SETTINGS, lastResult: result({ ok: true, status: 204 }) }), false);
  assert.equal(
    notificationHasFailure({ ...SETTINGS, lastResult: result({ ok: false, status: 404, code: 10015 }) }),
    true,
  );
});

test("直近結果の日時と status は Issue の表記で出す", () => {
  const at = Date.UTC(2026, 8, 24, 3, 31);
  assert.equal(resultTimeLabel(at, TIME_ZONE), "2026-09-24 12:31");
  assert.equal(
    resultMetaLabel({ ...result({ ok: true, status: 204 }), at, latencyMs: 142 }),
    "2026-09-24 12:31 / 204 No Content / 142 ms",
  );
  // 失敗時は status の数値と理由の両方を出す (受け入れ条件)
  assert.equal(
    resultMetaLabel({ ...result({ ok: false, status: 404 }), at, latencyMs: 98 }),
    "2026-09-24 12:31 / 404 Not Found / 98 ms",
  );
  assert.equal(
    resultMetaLabel({ ...result({ ok: false, status: 429 }), at, latencyMs: 12 }),
    "2026-09-24 12:31 / 429 Too Many Requests / 12 ms",
  );
  // 未知の status は数値だけ、応答が無いときは理由を出す
  assert.equal(
    resultMetaLabel({ ...result({ ok: false, status: 418 }), at, latencyMs: 5 }),
    "2026-09-24 12:31 / 418 / 5 ms",
  );
  assert.equal(
    resultMetaLabel({ ...result({ ok: false }), at, latencyMs: 5000 }),
    "2026-09-24 12:31 / 送信できませんでした / 5000 ms",
  );
  assert.equal(httpStatusLabel(404), "404 Not Found");
  assert.equal(httpStatusLabel(429), "429 Too Many Requests");
  assert.equal(httpStatusLabel(418), "418");
});

test("失敗文言は status と code から出し分け、URL と原文は使わない", () => {
  assert.deepEqual(notificationResultView(undefined), null);
  assert.deepEqual(notificationResultView(result({ ok: true, status: 204 })), {
    ok: true,
    headline: "送信できました。Discord のチャンネルを確認してください。",
  });
  assert.deepEqual(notificationResultView(result({ ok: false, status: 401 })), {
    ok: false,
    headline: "Webhook のトークンが正しくないか、権限がありません",
  });
  assert.deepEqual(
    notificationResultView(result({ ok: false, status: 404, code: 10015, message: "Unknown Webhook" })),
    {
      ok: false,
      headline: "Unknown Webhook (code 10015)",
      detail: "URL が削除済みか、コピーが途中で切れています。",
    },
  );
  assert.deepEqual(notificationResultView(result({ ok: false, status: 404 })), {
    ok: false,
    headline: "Webhook が見つかりません",
    detail: undefined,
  });
  assert.deepEqual(notificationResultView(result({ ok: false, status: 429 })), {
    ok: false,
    headline: "レート制限中です",
    detail: "時間を置いて再試行してください。",
  });
  // retryAfter があれば待機秒数を文言に含める (Issue の画面設計)
  assert.deepEqual(notificationResultView(result({ ok: false, status: 429, retryAfter: 2 })), {
    ok: false,
    headline: "レート制限中です",
    detail: "Retry-After 2 秒待ってから再試行してください。",
  });
  assert.deepEqual(
    notificationResultView(result({ ok: false, status: 429, message: "You are being rate limited.", retryAfter: 30 })),
    {
      ok: false,
      headline: "You are being rate limited.",
      detail: "Retry-After 30 秒待ってから再試行してください。",
    },
  );
  assert.deepEqual(notificationResultView(result({ ok: false, status: 500 })), {
    ok: false,
    headline: "Discord 側でエラーが発生しました",
    detail: "Discord 側の一時障害です。時間を置いて再試行してください。",
  });
  assert.deepEqual(notificationResultView(result({ ok: false, status: 400, message: "Bad payload" })), {
    ok: false,
    headline: "Bad payload",
  });
  // timeout / network は status が無い。サーバーの固定文言だけを出す
  assert.deepEqual(
    notificationResultView(result({ ok: false, message: "Discord へ接続できません（5 秒でタイムアウト）" })),
    {
      ok: false,
      headline: "Discord へ接続できません（5 秒でタイムアウト）",
      detail: "BFF から外部 HTTPS に出られるか確認してください。",
    },
  );
  assert.deepEqual(notificationResultView(result({ ok: false })), {
    ok: false,
    headline: "Discord へ接続できません。",
    detail: "BFF から外部 HTTPS に出られるか確認してください。",
  });
});

test("プレビューは baseUrl があるときだけリンク行を足す", () => {
  const base = draftFromSettings(SETTINGS);
  assert.deepEqual(notificationPreviewLines(base).slice(0, 3), [
    "✅ 完了  パンくずの折り返しを直す",
    "実装担当 ・ 4分12秒 ・ ツール 12件",
    "テストが 3 件失敗しています。修正して再実行してください。",
  ]);
  assert.equal(notificationPreviewLines(base).at(-1), "http://127.0.0.1:5173/s/a1b2c3d4e5");
  assert.equal(notificationPreviewLines({ ...base, baseUrl: "" }).length, 3);
  // 不正な URL はリンク行を出さない (保存はサーバーが 400 で拒否する)
  assert.equal(previewLink("not a url"), undefined);
  assert.equal(notificationPreviewLines({ ...base, baseUrl: "not a url" }).length, 3);
});

function result(input: Partial<NotificationResult> & { ok: boolean }): NotificationResult {
  return { latencyMs: 1, at: 0, ...input };
}
