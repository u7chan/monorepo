// コンテンツ生成タブの表示変換。選択肢の組み立て・現在値の解決・PUT の本文・入力の後始末を純関数で固定する
// (画面の描画は client/test/contentSettingsTab.test.ts の静的描画が担う)。

import assert from "node:assert/strict";
import test from "node:test";
import {
  contentKeyStatusBadge,
  contentProviderId,
  contentProviderLabel,
  deleteContentKeyConfirmRequest,
  imageCatalogNotice,
  imageCatalogRefreshNote,
  imageModelOptions,
  imageModelSelection,
  imageModelValue,
  keyDraftAfterSave,
} from "../src/lib/contentSettings";
import type { ContentImageSettings, ContentSettingsResponse } from "../src/types";

/** `image` の中身を差し替える (provider は設定面の値なので別引数) */
function settings(
  image: Partial<ContentImageSettings> = {},
  overrides: Partial<ContentSettingsResponse> = {},
): ContentSettingsResponse {
  return {
    configured: true,
    provider: "openrouter",
    runtimeAvailable: true,
    image: {
      model: "openai/gpt-image-2",
      models: [
        { provider: "openrouter", id: "openai/gpt-image-2", name: "GPT Image 2" },
        { provider: "openrouter", id: "google/gemini-image", name: "Gemini Image" },
        { provider: "openrouter", id: "mystery/image", name: "GPT Image 2" },
      ],
      catalogSource: "live",
      fetchedAt: null,
      ...image,
    },
    ...overrides,
  };
}

test("モデルの選択肢はカタログ順に並べ、同名は id を添えて一意にする", () => {
  const options = imageModelOptions(settings());
  assert.deepEqual(
    options.map((option) => option.label),
    ["GPT Image 2（openai/gpt-image-2）", "Gemini Image", "GPT Image 2（mystery/image）"],
  );
  assert.deepEqual(
    options.map((option) => option.value),
    ["openrouter/openai/gpt-image-2", "openrouter/google/gemini-image", "openrouter/mystery/image"],
  );
});

test("カタログ外の保存済みモデルは現在値として先頭に足す", () => {
  const options = imageModelOptions(settings({ model: "stale/model" }));
  assert.equal(options[0].value, "openrouter/stale/model");
  assert.equal(options[0].label, "stale/model（カタログ外）");
  assert.equal(options[0].model?.provider, "openrouter");
  assert.equal(options.length, 4, "カタログの 3 件を失わない");
});

test("現在値と PUT の本文を選択肢から解決する", () => {
  assert.equal(imageModelValue(settings()), "openrouter/openai/gpt-image-2");
  assert.equal(imageModelValue(settings({ model: null }, { provider: null })), "", "行が無ければ空文字");

  const options = imageModelOptions(settings());
  assert.deepEqual(imageModelSelection(options, options[1].value), {
    provider: "openrouter",
    model: "google/gemini-image",
  });
  assert.equal(imageModelSelection(options, "openrouter/unknown"), null, "選択肢に無い値は保存しない");
});

test("キー入力は保存に成功したときだけ消す", () => {
  assert.equal(keyDraftAfterSave("dummy-image-key", true), "");
  assert.equal(keyDraftAfterSave("dummy-image-key", false), "dummy-image-key");
});

test("削除の確認は新しい会話への影響と既存の会話の失敗を伝える", () => {
  const request = deleteContentKeyConfirmRequest("OpenRouter");
  assert.deepEqual(request.subject, { label: "対象の provider", value: "OpenRouter" });
  const body = request.body?.join("\n") ?? "";
  assert.match(body, /新しい会話/);
  assert.match(body, /キー無効エラー/);
  assert.equal(request.confirmLabel, "削除する");
  assert.ok(request.danger, "削除は danger にする");
});

test("キーの登録状態バッジと provider の id / 表示名", () => {
  assert.deepEqual(contentKeyStatusBadge(true), { label: "設定済み", tone: "ok" });
  assert.deepEqual(contentKeyStatusBadge(false), { label: "未設定", tone: "muted" });
  // v1 は openrouter だけなので、未設定 (null) も同じ provider へ寄せる (見出しのロゴも同じ id を引く)
  assert.equal(contentProviderId(null), "openrouter");
  assert.equal(contentProviderId("openrouter"), "openrouter");
  assert.equal(contentProviderId("other"), "other");
  assert.equal(contentProviderLabel(null), "OpenRouter");
  assert.equal(contentProviderLabel("openrouter"), "OpenRouter");
  assert.equal(contentProviderLabel("other"), "other", "知らない provider は id のまま出す");
});

test("モデル一覧の注記は取得元と最終取得時刻を示す", () => {
  assert.equal(
    imageCatalogNotice({ catalogSource: "live", fetchedAt: 0 }, { timeZone: "Asia/Tokyo", now: 0 }),
    "モデル一覧は OpenRouter から取得しました（最終取得: 09:00）",
  );
  assert.equal(
    imageCatalogNotice({ catalogSource: "stored", fetchedAt: 0 }, { timeZone: "Asia/Tokyo", now: 0 }),
    "OpenRouter から取得できなかったため、前回の一覧を表示しています（最終取得: 09:00）",
  );
  assert.equal(
    imageCatalogNotice({ catalogSource: "sdk", fetchedAt: null }),
    "OpenRouter から取得できていないため、SDK の組み込み一覧を表示しています",
  );
});

test("再取得の注記は成功と失敗を区別し、失敗でも一覧が残ることを伝える", () => {
  assert.equal(imageCatalogRefreshNote(null), "モデル一覧を取得しました。");
  assert.equal(
    imageCatalogRefreshNote("モデル一覧の取得がタイムアウトしました"),
    "モデル一覧の取得がタイムアウトしました。表示中の一覧は変わりません。",
  );
});
