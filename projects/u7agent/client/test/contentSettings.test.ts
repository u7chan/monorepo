// 設定 → コンテンツ生成（`/settings/content`）の表示変換。選択肢の組み立て・現在値の解決・PUT の本文・入力の後始末を純関数で固定する
// (画面の描画は client/test/contentSettingsTab.test.ts の静的描画が担う)。

import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogRefreshNote,
  contentEnabledNote,
  contentKeyErrorNotice,
  contentKeyStatusBadge,
  contentProviderId,
  contentProviderLabel,
  deleteContentKeyConfirmRequest,
  imageAuthBadge,
  imageAuthNotice,
  imageCatalogNotice,
  imageKeySectionVisible,
  imageModelOptions,
  imageModelSectionVisible,
  contentImageProviderLabel,
  contentImageProviderNote,
  IMAGE_PROVIDER_OPTIONS,
  imageModelSelection,
  imageModelValue,
  imageScreenModel,
  keyDraftAfterSave,
  speechCatalogNotice,
  speechDefaultVoice,
  speechModelOptions,
  speechModelValue,
  speechSaveDisabled,
  speechSelection,
  speechSpeed,
  speechSpeedStep,
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
    keyStored: true,
    keyAvailable: true,
    keyEvaluated: true,
    keyErrorMessage: null,
    keyEpoch: 0,
    enabled: true,
    disabledMessage: "コンテンツ生成は無効化されています。有効にするには 設定 → コンテンツ生成 を開いてください。",
    runtimeAvailable: true,
    bgm: { model: "google/lyria-3-clip-preview", format: "mp3", expectedDurationSeconds: 30 },
    image: {
      model: "openai/gpt-image-2",
      provider: "openrouter",
      auth: { state: "configured", kind: "api_key" },
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

test("モデルの選択肢は表示名の昇順に並べ、同名は id を添えて一意にする", () => {
  const options = imageModelOptions(settings());
  assert.deepEqual(
    options.map((option) => option.label),
    ["GPT Image 2（mystery/image）", "GPT Image 2（openai/gpt-image-2）", "Gemini Image"],
    "同名 2 件は id を添えたラベルの順になり、大文字の P は小文字の e より先になる",
  );
  assert.deepEqual(
    options.map((option) => option.value),
    ["openrouter/mystery/image", "openrouter/openai/gpt-image-2", "openrouter/google/gemini-image"],
  );
});

test("name が空のモデルは id を表示名にして id 順に並べる", () => {
  const options = imageModelOptions(
    settings({
      model: "mystery/mid",
      models: [
        { provider: "openrouter", id: "mystery/zeta", name: "" },
        { provider: "openrouter", id: "mystery/mid", name: "" },
        { provider: "openrouter", id: "mystery/alpha", name: "" },
      ],
    }),
  );
  assert.deepEqual(
    options.map((option) => option.label),
    ["mystery/alpha", "mystery/mid", "mystery/zeta"],
  );
});

test("表示名の比較はケースを無視せず、小文字始まりを大文字始まりの後ろへ回す", () => {
  const options = imageModelOptions(
    settings({
      model: null,
      models: [
        { provider: "openrouter", id: "xai/grok-imagine", name: "xAI: Grok Imagine Image 2.0" },
        { provider: "openrouter", id: "black-forest-labs/flux", name: "Black Forest Labs: FLUX 3" },
        { provider: "openrouter", id: "google/gemini-image", name: "Google: Gemini 2.5 Flash Image" },
      ],
    }),
  );
  assert.deepEqual(
    options.map((option) => option.label),
    ["Black Forest Labs: FLUX 3", "Google: Gemini 2.5 Flash Image", "xAI: Grok Imagine Image 2.0"],
  );
});

test("カタログ外の保存済みモデルは現在値として先頭に足す", () => {
  const options = imageModelOptions(settings({ model: "stale/model" }));
  assert.equal(options[0].value, "openrouter/stale/model");
  assert.equal(options[0].label, "stale/model（カタログ外）");
  assert.equal(options[0].model?.provider, "openrouter");
  assert.equal(options.length, 4, "カタログの 3 件を失わない");
});

test("画面のモデルは下書きを優先し、未設定では空文字（試行と証拠もこの値を使う）", () => {
  const savedModel = imageModelValue(settings());
  // 保存前でも画面の選択が正。保存値と混ぜると、保存前の試行が別モデルで走る
  assert.equal(
    imageScreenModel({ draft: "openrouter/google/gemini-image", savedModel }),
    "openrouter/google/gemini-image",
  );
  assert.equal(imageScreenModel({ draft: null, savedModel }), savedModel);
  assert.equal(imageScreenModel({ draft: null, savedModel: "" }), "", "行が無ければ空文字");
});

test("現在値と PUT の本文を選択肢から解決する", () => {
  assert.equal(imageModelValue(settings()), "openrouter/openai/gpt-image-2");
  assert.equal(imageModelValue(settings({ model: null }, { provider: null })), "", "行が無ければ空文字");

  const options = imageModelOptions(settings());
  const gemini = options.find((option) => option.value === "openrouter/google/gemini-image");
  assert.ok(gemini, "カタログの Gemini Image を選択肢から引ける");
  assert.deepEqual(imageModelSelection(options, gemini.value), {
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

test("音声モデルの選択肢は表示名の昇順に並べ、同名は id を添え、カタログ外の現在値を先頭に残す", () => {
  const options = speechModelOptions(settings());
  assert.deepEqual(
    options.map((option) => option.label),
    [
      "Fish Audio",
      "Google: Gemini 3.8 Flash TTS（google/gemini-3.8-flash-tts）",
      "Google: Gemini 3.8 Flash TTS（mystery/tts）",
    ],
  );
  assert.deepEqual(
    options.map((option) => option.value),
    ["fish/audio", "google/gemini-3.8-flash-tts", "mystery/tts"],
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

test("カタログの並びが取得元で変わっても選択肢は同じ表示名の昇順になる", () => {
  // 取得元で変わる 2 通りの並び（live は新しい順、SDK 同梱は id 順）を与える
  const live = [
    { provider: "openrouter", id: "heygen/voice-1", name: "HeyGen: Voice 1" },
    { provider: "openrouter", id: "fish/audio", name: "Fish Audio" },
    { provider: "openrouter", id: "elevenlabs/eleven-v4", name: "ElevenLabs: Eleven v4" },
  ];
  const sdk = [...live].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const labelsOf = (models: typeof live) =>
    speechModelOptions(settings({}, {}, { model: null, models })).map((option) => option.label);

  assert.deepEqual(labelsOf(live), ["ElevenLabs: Eleven v4", "Fish Audio", "HeyGen: Voice 1"]);
  assert.deepEqual(labelsOf(sdk), labelsOf(live));
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

test("速度の増減は 1.0 を起点に 0.1 刻みで動かし、空欄と不正値では起点を 1.0 へ寄せる", () => {
  // 空欄は「未指定」なので、押した瞬間だけ 1.0 を起点にする（値は押下で初めて入る）
  assert.equal(speechSpeedStep("", 0.1), "1.1");
  assert.equal(speechSpeedStep("", -0.1), "0.9");
  assert.equal(speechSpeedStep("1", 0.1), "1.1");
  assert.equal(speechSpeedStep("0.8", -0.1), "0.7");
  // 押しても何も起きないボタンを作らない（不正値と 0 以下は 1.0 を起点にする）
  assert.equal(speechSpeedStep("fast", 0.1), "1.1");
  assert.equal(speechSpeedStep("0", 0.1), "1.1");
  assert.equal(speechSpeedStep("-1", -0.1), "0.9");
  // 0 以下は送れないため、押下だけで不正値を作らない（上限は provider の 400 に委ねる）
  assert.equal(speechSpeedStep("0.1", -0.1), "0.1");
  assert.equal(speechSpeedStep("2", 0.1), "2.1");
});

test("速度の増減は十進の桁で小数 2 桁へ丸め、押下だけで不正値を作らない", () => {
  // 0.1 ずつ足した値が 0.7000000000000001 のように欄へ出ない
  assert.equal(speechSpeedStep("0.6", 0.1), "0.7");
  assert.equal(speechSpeedStep("1.05", 0.1), "1.15");
  // 小数第 3 位以下も十進の桁で丸める（二進の誤差があると 1.015 - 0.1 が 0.92 にならない）
  assert.equal(speechSpeedStep("1.015", -0.1), "0.92");
  assert.equal(speechSpeedStep("1.005", 0.1), "1.11");
  assert.equal(speechSpeedStep("1.014", -0.1), "0.91");
  // 同じ数値なら、符号・小数点の前の 0 省略・指数表記で結果を変えない
  for (const raw of ["0.565", ".565", "+0.565", "5.65e-1", "0.5650"]) {
    assert.equal(speechSpeedStep(raw, 0.1), "0.67", `${raw} の増加`);
    assert.equal(speechSpeedStep(raw, -0.1), "0.47", `${raw} の減少`);
  }
  assert.equal(speechSpeedStep("1.005e0", 0.1), "1.11");
  // 有限でも押下で 1/100 単位を溢れる値から Infinity を作らない
  for (const raw of ["1e307", "1".repeat(400)]) {
    for (const delta of [0.1, -0.1]) {
      const stepped = speechSpeedStep(raw, delta);
      assert.ok(speechSpeed(stepped).ok, `${raw} の押下結果 ${stepped} は送信前の検証を通る`);
    }
  }
});

test("速度の増減は丸めで 0 単位になる正の値を未指定と混同しない", () => {
  // 0.004 は送信前の検証を通る正の値なので、起点 1.0 へは飛ばさず下限で止める
  for (const raw of ["0.004", ".004", "4e-3", "0.0001", "1e-7"]) {
    assert.equal(speechSpeedStep(raw, 0.1), "0.1", `${raw} の増加`);
    assert.equal(speechSpeedStep(raw, -0.1), "0.1", `${raw} の減少`);
  }
  // 0 は送信前の検証が弾く値なので、空欄と同じ起点にする
  assert.equal(speechSpeedStep("0", 0.1), "1.1");
  assert.equal(speechSpeedStep("0.000", -0.1), "0.9");
});

test("有効 / 無効の注記は、既存の会話にも効くこととキーが残ることを伝える", () => {
  const on = contentEnabledNote(true);
  assert.ok(on.includes("有効にしました"));
  assert.ok(on.includes("ツールを持つ既存の会話"), "ツール一覧はセッション作成時に固定される前提で書く");
  assert.ok(on.includes("OFF の間に作った会話にはツールが無い"), "ON で既存の会話すべてが使えると誤解させない");
  assert.equal(on.includes("キーと選択は残ります"), false, "有効化では削除との違いを説かない");

  const off = contentEnabledNote(false);
  assert.ok(off.includes("無効にしました"));
  assert.ok(off.includes("固定の文言で失敗します"));
  assert.ok(off.includes("キーと選択は残ります"), "キー削除と混同させない");
});

test("キーのバッジは保存済み (keyStored) を見て、復号できないキーを設定済みと出さない", () => {
  assert.deepEqual(contentKeyStatusBadge(false), { label: "未設定", tone: "muted" });
  assert.deepEqual(contentKeyStatusBadge(true), { label: "設定済み", tone: "ok" });
  assert.deepEqual(
    contentKeyStatusBadge(true, false),
    { label: "利用不可", tone: "warn" },
    "configured は true でもキーが無い / 復号できないときは設定済みと言わない",
  );
});

test("キーが使えない理由は、サーバーの固定文言をそのまま出す", () => {
  assert.equal(contentKeyErrorNotice(settings({}, { keyStored: false })), null, "未設定では警告を出さない");
  assert.equal(
    contentKeyErrorNotice(settings({}, { keyStored: true, keyAvailable: true })),
    null,
    "使えるキーには警告を出さない",
  );
  assert.equal(
    contentKeyErrorNotice(
      settings({}, { keyStored: true, keyAvailable: false, keyErrorMessage: "master key が未設定です" }),
    ),
    "master key が未設定です",
    "原因は推測せずサーバーの文言を渡す",
  );
});

// --- 画像の生成元（OpenRouter / Codex）。値の正は server の DTO で、ここは表示の対応だけを持つ ---

test("生成元の選択肢は 2 つで、表示名と案内を持つ", () => {
  assert.deepEqual(
    IMAGE_PROVIDER_OPTIONS.map((option) => option.value),
    ["openrouter", "codex"],
  );
  assert.equal(contentImageProviderLabel("openrouter"), "OpenRouter");
  assert.equal(contentImageProviderLabel("codex"), "Codex");
  assert.match(contentImageProviderNote("codex"), /既存の会話/);
  assert.match(contentImageProviderNote("codex"), /新しい会話/);
});

test("認証状態は「認証済み / 期限切れ / 未認証」に分け、未設定でも種類を隠さない", () => {
  assert.deepEqual(imageAuthBadge({ state: "configured", kind: "oauth" }), { label: "認証済み", tone: "ok" });
  assert.deepEqual(imageAuthBadge({ state: "expired", kind: "oauth" }), { label: "認証の期限切れ", tone: "warn" });
  assert.deepEqual(imageAuthBadge({ state: "missing", kind: null }), { label: "未認証", tone: "muted" });
});

test("認証がないときの案内は provider ごとに変え、Codex にAPIキーを求めない", () => {
  assert.equal(imageAuthNotice({ state: "configured", kind: "oauth" }, "codex"), null);
  assert.match(imageAuthNotice({ state: "missing", kind: null }, "codex") ?? "", /openai-codex/);
  assert.match(imageAuthNotice({ state: "missing", kind: null }, "codex") ?? "", /APIキーは不要/);
  assert.match(imageAuthNotice({ state: "expired", kind: "oauth" }, "codex") ?? "", /期限が切れています/);
  assert.match(imageAuthNotice({ state: "missing", kind: "api_key" }, "openrouter") ?? "", /OpenRouter のAPIキー/);
});

test("Codex では APIキー欄とモデル一覧を出さない（OpenRouter では出す）", () => {
  assert.equal(imageKeySectionVisible("openrouter"), true);
  assert.equal(imageKeySectionVisible("codex"), false);
  assert.equal(imageModelSectionVisible("openrouter"), true);
  assert.equal(imageModelSectionVisible("codex"), false);
});
