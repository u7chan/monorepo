// コンテンツ生成タブの表示変換。選択肢の組み立て・現在値の解決・PUT の本文・入力の後始末を純関数で固定する
// (画面の描画は client/test/contentSettingsTab.test.ts の静的描画が担う)。

import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogRefreshNote,
  contentKeyStatusBadge,
  contentProviderId,
  contentProviderLabel,
  deleteContentKeyConfirmRequest,
  imageCatalogNotice,
  imageModelOptions,
  imageModelSelection,
  imageModelValue,
  keyDraftAfterSave,
  speechCatalogNotice,
  speechDefaultVoice,
  speechModelOptions,
  speechModelValue,
  speechSaveDisabled,
  speechSelection,
  speechSettingsAfterRefresh,
  speechSyncedAfterRefresh,
  speechVoiceDraft,
  speechVoiceMode,
  speechVoiceValue,
} from "../src/lib/contentSettings";
import type { ContentImageSettings, ContentSettingsResponse, ContentSpeechSettings } from "../src/types";

/** `image` / `speech` の中身を差し替える (provider は設定面の値なので別引数) */
function settings(
  image: Partial<ContentImageSettings> = {},
  overrides: Partial<ContentSettingsResponse> = {},
  speech: Partial<ContentSpeechSettings> = {},
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
    speech: {
      model: "google/gemini-3.8-flash-tts",
      voice: "Zephyr",
      models: [
        {
          provider: "openrouter",
          id: "google/gemini-3.8-flash-tts",
          name: "Google: Gemini 3.8 Flash TTS",
          voices: ["Zephyr", "Kore"],
        },
        { provider: "openrouter", id: "fish/audio", name: "Fish Audio" },
        { provider: "openrouter", id: "mystery/tts", name: "Google: Gemini 3.8 Flash TTS", voices: ["Aoede"] },
      ],
      catalogSource: "live",
      fetchedAt: null,
      ...speech,
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
  assert.equal(catalogRefreshNote(null), "モデル一覧を取得しました。");
  assert.equal(
    catalogRefreshNote("モデル一覧の取得がタイムアウトしました"),
    "モデル一覧の取得がタイムアウトしました。表示中の一覧は変わりません。",
  );
});

test("音声モデルの選択肢はカタログ順に並べ、同名は id を添え、カタログ外の現在値を先頭に残す", () => {
  const options = speechModelOptions(settings());
  assert.deepEqual(
    options.map((option) => option.label),
    [
      "Google: Gemini 3.8 Flash TTS（google/gemini-3.8-flash-tts）",
      "Fish Audio",
      "Google: Gemini 3.8 Flash TTS（mystery/tts）",
    ],
  );
  assert.deepEqual(
    options.map((option) => option.value),
    ["google/gemini-3.8-flash-tts", "fish/audio", "mystery/tts"],
    "音声の provider は v1 では openrouter 固定なので id だけを使う",
  );

  const stale = speechModelOptions(settings({}, {}, { model: "stale/tts" }));
  assert.equal(stale[0].value, "stale/tts");
  assert.equal(stale[0].label, "stale/tts（カタログ外）");
  assert.equal(stale[0].model?.provider, "openrouter", "未設定の provider も既定へ寄せる");
  assert.equal(stale.length, 4, "カタログの 3 件を失わない");

  assert.equal(speechModelValue(settings()), "google/gemini-3.8-flash-tts");
  assert.equal(speechModelValue(settings({}, {}, { model: null })), "", "行が無ければ空文字");
});

test("音声の PUT 本文と、モデルごとのボイス欄の規則", () => {
  const options = speechModelOptions(settings());
  assert.deepEqual(speechSelection(options, "fish/audio", ""), { model: "fish/audio", voice: "" });
  assert.deepEqual(speechSelection(options, "google/gemini-3.8-flash-tts", "Kore"), {
    model: "google/gemini-3.8-flash-tts",
    voice: "Kore",
  });
  assert.equal(speechSelection(options, "ghost", "Zephyr"), null, "選択肢に無い値は保存しない");

  const declared = options.find((option) => option.value === "google/gemini-3.8-flash-tts");
  const free = options.find((option) => option.value === "fish/audio");
  assert.equal(speechVoiceMode(declared), "select");
  assert.equal(speechVoiceMode(free), "text", "宣言が無いモデルは自由記述を許す");
  assert.equal(speechVoiceMode(undefined), "text");

  assert.equal(speechVoiceValue(declared, "Kore"), "Kore", "宣言にある保存値は維持する");
  assert.equal(speechVoiceValue(declared, "Zephyr"), "Zephyr");
  assert.equal(speechVoiceValue(declared, "Ghost"), "Zephyr", "宣言外へ変わった後は先頭へ寄せる");
  assert.equal(speechVoiceValue(declared, ""), "Zephyr", "未設定は先頭にする");
  assert.equal(speechVoiceValue(free, "any-voice-id"), "any-voice-id", "自由記述は保存値のまま");
  assert.equal(speechVoiceValue(free, ""), "");
});

test("モデル切替時のボイスは新しいモデルの先頭へ寄せ、宣言が無ければ空にする", () => {
  const options = speechModelOptions(settings());
  const gemini = options.find((option) => option.value === "google/gemini-3.8-flash-tts");
  const fish = options.find((option) => option.value === "fish/audio");

  assert.equal(speechDefaultVoice(gemini), "Zephyr");
  assert.equal(speechDefaultVoice(fish), "", "宣言が無いモデルは空（送らない）");
  assert.equal(speechDefaultVoice(undefined), "");

  // 同じモデルでは保存値に追随する（宣言内なら維持、宣言外なら先頭）
  assert.equal(speechVoiceDraft({ draft: null, modelChanged: false, option: gemini, savedVoice: "Kore" }), "Kore");
  assert.equal(speechVoiceDraft({ draft: null, modelChanged: false, option: gemini, savedVoice: "Ghost" }), "Zephyr");
  assert.equal(
    speechVoiceDraft({ draft: null, modelChanged: false, option: fish, savedVoice: "any-voice-id" }),
    "any-voice-id",
  );

  // 切替直後は旧モデルのボイスを持ち越さない（宣言が無いモデルでは空、宣言があっても先頭）
  assert.equal(speechVoiceDraft({ draft: null, modelChanged: true, option: fish, savedVoice: "Zephyr" }), "");
  assert.equal(speechVoiceDraft({ draft: null, modelChanged: true, option: gemini, savedVoice: "Kore" }), "Zephyr");
  assert.equal(speechVoiceDraft({ draft: null, modelChanged: true, option: gemini, savedVoice: "Zephyr" }), "Zephyr");

  // 選択欄を触った後の値は切替でも尊重する（ユーザーの選択を上書きしない）
  assert.equal(speechVoiceDraft({ draft: "Kore", modelChanged: true, option: fish, savedVoice: "Zephyr" }), "Kore");
});

test("音声カタログ再取得後は server の現在値へ同期し、表示と実行時のボイスを食い違わせない", () => {
  const reordered = [
    {
      provider: "openrouter",
      id: "google/gemini-3.8-flash-tts",
      name: "Google: Gemini 3.8 Flash TTS",
      voices: ["Kore", "Zephyr"],
    },
  ];
  const previous = settings({}, {}, { voice: "Zephyr" });
  const refreshed = { models: reordered, catalogSource: "live" as const, fetchedAt: 2000 };
  const current = settings({}, {}, { voice: "Kore", models: reordered, fetchedAt: 2000 });

  assert.deepEqual(
    speechSettingsAfterRefresh(previous, refreshed, current),
    current,
    "GET が取れていれば server の現在値（NULL ボイスのフォールバックを含む）を正とする",
  );

  // GET が取れなかったときだけ、一覧と出どころを差し替える（ボイスは据え置き）
  const patched = speechSettingsAfterRefresh(previous, refreshed, null);
  assert.equal(patched?.speech.voice, "Zephyr");
  assert.equal(patched?.speech.fetchedAt, 2000);
  assert.deepEqual(patched?.speech.models, reordered);
  assert.equal(speechSettingsAfterRefresh(null, refreshed, null), null);

  // 再現条件: 保存ボイスが NULL（旧一覧の先頭 Zephyr を見せている）で、再取得が [Kore, Zephyr] を返して成功し、
  // 直後の GET だけ失敗する。実行時は Kore へ解決するため、旧 Zephyr を現在値として扱ってはいけない
  assert.equal(
    speechSyncedAfterRefresh(true, { catalogError: null }, null),
    false,
    "一覧が変わったのに現在値を確認できない",
  );
  assert.equal(speechSyncedAfterRefresh(true, { catalogError: null }, current), true, "成功した GET で確認できる");
  assert.equal(
    speechSyncedAfterRefresh(true, { catalogError: "モデル一覧の取得がタイムアウトしました" }, null),
    true,
    "既に同期済みで一覧が変わらない再取得の失敗は、以前の値を現在値のまま保つ",
  );
  // 未同期の状態から再取得を試み、上流が 503 + POST は 200（catalogError あり）+ GET も失敗する組合せ。
  // 成功した GET が取れるまで未同期のままにする（旧値へ戻さない）
  assert.equal(
    speechSyncedAfterRefresh(
      false,
      { catalogError: "モデル一覧の取得が混雑しています（レート制限またはプロバイダー障害）" },
      null,
    ),
    false,
    "未同期は GET が成功するまで false のまま",
  );
  assert.equal(speechSyncedAfterRefresh(false, { catalogError: null }, current), true, "成功した GET で復帰する");
  assert.equal(speechSaveDisabled({ busy: false, synced: false, dirty: true }), true, "同期できない間は保存させない");
  assert.equal(speechSaveDisabled({ busy: false, synced: true, dirty: true }), false);
  assert.equal(speechSaveDisabled({ busy: false, synced: true, dirty: false }), true, "変更が無ければ保存しない");
  assert.equal(speechSaveDisabled({ busy: true, synced: true, dirty: true }), true);
});

test("音声モデル一覧の注記は取得元と最終取得時刻を示し、default は同梱を見ていることを伝える", () => {
  assert.equal(
    speechCatalogNotice({ catalogSource: "live", fetchedAt: 0 }, { timeZone: "Asia/Tokyo", now: 0 }),
    "音声モデル一覧は OpenRouter から取得しました（最終取得: 09:00）",
  );
  assert.equal(
    speechCatalogNotice({ catalogSource: "stored", fetchedAt: 0 }, { timeZone: "Asia/Tokyo", now: 0 }),
    "OpenRouter から取得できなかったため、前回の音声モデル一覧を表示しています（最終取得: 09:00）",
  );
  assert.equal(
    speechCatalogNotice({ catalogSource: "default", fetchedAt: null }),
    "OpenRouter から取得できていないため、同梱の既定の音声モデルを表示しています",
  );
});
