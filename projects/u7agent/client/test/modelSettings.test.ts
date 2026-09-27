// 設定 → モデルの表示変換。DOM を使わず、認証バッジ・並び・入力検証・保存後の文言だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  API_KEY_MAX_LENGTH,
  API_KEY_MIN_LENGTH,
  AVAILABILITY_SAVE_INITIAL,
  allowedModelsOutsideCatalog,
  availabilityCounts,
  availabilityDefaultChoices,
  availabilityDraftFromSettings,
  availabilityDraftIsDirty,
  availabilityDraftWithAllModels,
  availabilityGroups,
  availabilityNotice,
  availabilitySaveConfirmMessage,
  availabilitySaveOnSubmit,
  availableCountOf,
  degradedNotice,
  deleteConfirmMessage,
  groupProviders,
  modelRefKey,
  mutationNote,
  normalizeAllowedModels,
  providerAuthBadge,
  resyncAvailable,
  sameAvailabilitySettings,
  setAvailabilityProviderModels,
  validateApiKey,
} from "../src/lib/modelSettings";
import type {
  ModelMutationResponse,
  ModelsSettingsResponse,
  ProviderAuthSetting,
  RuntimeModelsResponse,
} from "../src/types";

function provider(overrides: Partial<ProviderAuthSetting> = {}): ProviderAuthSetting {
  return {
    provider: "anthropic",
    name: "Anthropic",
    auth: { configured: false, environmentVariables: [] },
    managed: false,
    canSetApiKey: true,
    supportsOAuth: false,
    orphan: false,
    ...overrides,
  };
}

const CATALOG: RuntimeModelsResponse = {
  catalogCount: 3,
  availableCount: 1,
  versions: { piCodingAgent: "0.87.1" },
  providers: [
    {
      provider: "anthropic",
      auth: { configured: true, source: "environment", environmentVariables: [] },
      models: [
        { id: "a", name: "A", available: true },
        { id: "b", name: "B", available: false },
      ],
    },
    {
      provider: "local",
      auth: { configured: false, environmentVariables: [] },
      models: [{ id: "c", name: "C", available: false }],
    },
  ],
};

function settings(overrides: Partial<ModelsSettingsResponse> = {}): ModelsSettingsResponse {
  return {
    runtimeAvailable: true,
    allowedModels: null,
    defaultModel: null,
    ignoredEnvironmentVariables: [],
    providers: [],
    ...overrides,
  };
}

test("認証バッジは保存行・実効値・未反映を混ぜずに出し分ける", () => {
  assert.deepEqual(providerAuthBadge(provider()), { label: "未設定", tone: "muted" });
  assert.deepEqual(providerAuthBadge(provider({ supportsOAuth: true })), {
    label: "未設定（OAuth 可）",
    tone: "muted",
  });
  assert.deepEqual(
    providerAuthBadge(
      provider({ auth: { configured: true, source: "environment", environmentVariables: ["ANTHROPIC_API_KEY"] } }),
    ),
    { label: "環境変数（ANTHROPIC_API_KEY）", tone: "ok" },
  );
  assert.deepEqual(
    providerAuthBadge(provider({ auth: { configured: true, source: "stored", environmentVariables: [] } })),
    {
      label: "保存済み（auth.json）",
      tone: "ok",
    },
  );
  assert.deepEqual(
    providerAuthBadge(provider({ auth: { configured: true, source: "runtime", environmentVariables: [] } })),
    {
      label: "この画面で登録済み（実効）",
      tone: "ok",
    },
  );
  assert.deepEqual(
    providerAuthBadge(provider({ auth: { configured: true, source: "models_json_key", environmentVariables: [] } })),
    { label: "models.json のキー", tone: "ok" },
  );
  // 未知の出所は分類名だけを出し、生のラベルを混ぜない
  assert.deepEqual(
    providerAuthBadge(provider({ auth: { configured: true, source: "unknown", environmentVariables: [] } })),
    { label: "認証済み", tone: "ok" },
  );
  // managed でも実効の出所が別なら、実効側を表示する
  assert.deepEqual(
    providerAuthBadge(
      provider({ managed: true, auth: { configured: true, source: "environment", environmentVariables: [] } }),
    ),
    { label: "環境変数", tone: "ok" },
  );
});

test("未反映 (degraded) とカタログ外は警告として先に出す", () => {
  assert.deepEqual(providerAuthBadge(provider({ managed: true, degraded: "apply" })), {
    label: "保存済み（未反映）",
    tone: "warn",
  });
  assert.deepEqual(providerAuthBadge(provider({ degraded: "remove" })), { label: "削除が未反映", tone: "warn" });
  assert.deepEqual(providerAuthBadge(provider({ orphan: true, managed: true })), {
    label: "カタログ外（保存済み）",
    tone: "warn",
  });
  assert.deepEqual(providerAuthBadge(provider({ orphan: true })), { label: "カタログ外", tone: "warn" });
});

test("再同期はカタログにある provider か degraded remove のときだけ出す", () => {
  assert.equal(resyncAvailable(provider()), false);
  assert.equal(resyncAvailable(provider({ degraded: "apply" })), true);
  assert.equal(resyncAvailable(provider({ degraded: "remove" })), true);
  // カタログ外の apply は再同期しても直らない (サーバーも 400 にする) ので削除だけを出す
  assert.equal(resyncAvailable(provider({ orphan: true, degraded: "apply" })), false);
  assert.equal(resyncAvailable(provider({ orphan: true, degraded: "remove" })), true);
});

test("未反映の案内はそのカードで押せる回復操作と一致する (カタログ外では再同期を案内しない)", () => {
  assert.equal(degradedNotice(provider()), undefined, "未反映でなければ案内は無い");

  const cases = [
    provider({ degraded: "apply", managed: true }),
    provider({ degraded: "remove", managed: false }),
    provider({ degraded: "apply", managed: true, orphan: true }),
    provider({ degraded: "remove", managed: false, orphan: true }),
  ];
  for (const entry of cases) {
    const text = degradedNotice(entry) ?? "";
    assert.notEqual(text, "", `${entry.degraded} の案内を出す`);
    // 押せない操作を探させない: [再同期] を案内するなら、そのカードに再同期のボタンが出ること
    if (text.includes("[再同期]")) {
      assert.equal(resyncAvailable(entry), true, `再同期を案内するなら実行できる: ${JSON.stringify(entry)}`);
    }
  }

  const orphanApply = degradedNotice(provider({ degraded: "apply", managed: true, orphan: true })) ?? "";
  assert.match(orphanApply, /\[削除\]/, "カタログ外の apply は削除を案内する");
  assert.match(orphanApply, /カタログに戻ってから/, "復帰手段としてカタログ復帰も案内する");
  assert.equal(resyncAvailable(provider({ degraded: "apply", managed: true, orphan: true })), false);
  assert.match(
    degradedNotice(provider({ degraded: "remove", managed: false, orphan: true })) ?? "",
    /\[再同期\]/,
    "カタログ外でも remove は再同期で消せる (サーバーも受ける)",
  );
});

test("設定済みを先頭に、未設定は後ろへ分ける (並びはサーバーの順)", () => {
  const configured: ModelsSettingsResponse = settings({
    providers: [
      provider({
        provider: "configured-env",
        auth: { configured: true, source: "environment", environmentVariables: [] },
      }),
      provider({ provider: "unset-a" }),
      provider({ provider: "managed", managed: true }),
      provider({ provider: "anthropic", auth: { configured: false, environmentVariables: [] } }),
      provider({ provider: "unset-b", orphan: true }),
    ],
  });
  const groups = groupProviders(configured, CATALOG);
  assert.deepEqual(
    groups.configured.map((entry) => entry.provider),
    ["configured-env", "managed", "anthropic"],
    "カタログに available があれば設定済みとして先頭に置く",
  );
  assert.deepEqual(
    groups.unconfigured.map((entry) => entry.provider),
    ["unset-a", "unset-b"],
  );
  assert.equal(availableCountOf(CATALOG, "anthropic"), 1);
  assert.equal(availableCountOf(CATALOG, "unknown"), 0);
  assert.equal(availableCountOf(null, "anthropic"), 0);
});

test("APIキーの長さはサーバーと同じ境界で検証する", () => {
  assert.equal(validateApiKey("a".repeat(API_KEY_MIN_LENGTH - 1)), "APIキーは 8 文字以上で入力してください。");
  assert.equal(validateApiKey("a".repeat(API_KEY_MIN_LENGTH)), undefined);
  assert.equal(validateApiKey("a".repeat(API_KEY_MAX_LENGTH)), undefined);
  assert.equal(validateApiKey("a".repeat(API_KEY_MAX_LENGTH + 1)), "APIキーは 2048 文字以内で入力してください。");
});

test("変更系の注記は state ごとに再同期を案内する", () => {
  const base = settings();
  const applied: ModelMutationResponse = { ...base, state: "applied" };
  const unsynced: ModelMutationResponse = { ...base, state: "applied_unsynced" };
  assert.deepEqual(mutationNote("save", applied), {
    text: "APIキーを保存しました。モデル候補を更新しています。",
    error: false,
  });
  assert.equal(mutationNote("save", unsynced).error, true);
  assert.match(mutationNote("save", unsynced).text, /再同期/);
  assert.equal(mutationNote("delete", applied).error, false);
  assert.match(mutationNote("delete", applied).text, /削除しました/);
  assert.match(mutationNote("delete", unsynced).text, /削除は.*未反映/);
  assert.equal(mutationNote("resync", applied).error, false);
  assert.equal(mutationNote("resync", unsynced).error, true);
  // 利用可能なモデルは SDK 呼び出しを含まないため、200 は常に applied
  assert.deepEqual(mutationNote("availability", applied), {
    text: "利用可能なモデルを保存しました。新しい会話の候補を更新しています。",
    error: false,
  });
});

test("削除の確認は既存会話への影響を伝える", () => {
  const message = deleteConfirmMessage("Anthropic");
  assert.match(message, /Anthropic/);
  assert.match(message, /未ロードの会話/);
  assert.match(message, /auth\.json/);
});

// --- 利用可能なモデル（許可リスト）と既定モデルの編集 ---

// API の allowedModels と同じ "provider/model" の表記
const KEY_A = "anthropic/a";
const KEY_B = "anthropic/b";
const KEY_C = "local/c";
const KEY_GHOST = "anthropic/ghost";

test("保存値から下書きを作り、空配列は制限なしへ正規化する", () => {
  assert.deepEqual(availabilityDraftFromSettings(settings()), {
    unrestricted: true,
    allowed: [],
    defaultModel: null,
  });
  assert.deepEqual(availabilityDraftFromSettings(settings({ allowedModels: [KEY_A], defaultModel: KEY_A })), {
    unrestricted: false,
    allowed: [KEY_A],
    defaultModel: KEY_A,
  });
  assert.equal(normalizeAllowedModels([]), null);
  assert.deepEqual(normalizeAllowedModels([KEY_A]), [KEY_A]);
  assert.equal(modelRefKey({ provider: "anthropic", id: "a" }), KEY_A);
});

test("制限なしへ戻す候補はカタログ全件で、カタログ外の残存エントリを分ける", () => {
  assert.deepEqual(availabilityDraftWithAllModels(CATALOG), [KEY_A, KEY_B, KEY_C]);
  assert.deepEqual(availabilityDraftWithAllModels(null), []);
  assert.deepEqual(allowedModelsOutsideCatalog([KEY_A, KEY_GHOST], CATALOG), [KEY_GHOST]);
  assert.deepEqual(allowedModelsOutsideCatalog([KEY_A], null), [KEY_A]);
});

test("集計は制限なしならカタログ全件、選んだときは積で数える", () => {
  assert.deepEqual(availabilityCounts({ unrestricted: true, allowed: [], defaultModel: null }, CATALOG), {
    catalog: 3,
    allowed: 3,
    available: 1,
  });
  assert.deepEqual(
    availabilityCounts({ unrestricted: false, allowed: [KEY_B, KEY_C], defaultModel: null }, CATALOG),
    { catalog: 3, allowed: 2, available: 0 },
    "許可した 2 件はいずれも未認証",
  );
  assert.equal(availabilityCounts({ unrestricted: true, allowed: [], defaultModel: null }, null), undefined);
});

test("provider ごとの行は利用可能数の降順で、同数ならカタログ順を保ち、available false も含める", () => {
  const groups = availabilityGroups({ unrestricted: false, allowed: [KEY_B], defaultModel: null }, CATALOG);
  assert.deepEqual(
    groups.map((group) => group.provider),
    ["anthropic", "local"],
    "利用可能モデル数の多い group を先にする",
  );
  assert.deepEqual(
    groups[0]?.rows.map((row) => [row.key, row.checked, row.available]),
    [
      [KEY_A, false, true],
      [KEY_B, true, false],
    ],
  );
  // 制限なしでは全件チェックになる
  const all = availabilityGroups({ unrestricted: true, allowed: [], defaultModel: null }, CATALOG);
  assert.deepEqual(
    all.flatMap((group) => group.rows.map((row) => row.checked)),
    [true, true, true],
  );

  const catalog: RuntimeModelsResponse = {
    ...CATALOG,
    providers: [
      {
        provider: "first",
        auth: { configured: false, environmentVariables: [] },
        models: [{ id: "a", name: "A", available: true }],
      },
      {
        provider: "second",
        auth: { configured: false, environmentVariables: [] },
        models: [
          { id: "a", name: "A", available: true },
          { id: "b", name: "B", available: true },
          { id: "c", name: "C", available: false },
        ],
      },
      {
        provider: "third",
        auth: { configured: false, environmentVariables: [] },
        models: [{ id: "a", name: "A", available: true }],
      },
    ],
  };
  const sorted = availabilityGroups({ unrestricted: false, allowed: [], defaultModel: null }, catalog);
  assert.deepEqual(
    sorted.map((group) => [group.provider, group.rows.length]),
    [
      ["second", 3],
      ["first", 1],
      ["third", 1],
    ],
    "利用不可の行も group に含め、available 数同数はカタログ順を保つ",
  );
});

test("下書きの未保存判定は allowed を集合として比べ、unrestricted 中は無視する", () => {
  const unrestricted = { unrestricted: true, allowed: [], defaultModel: null };
  assert.equal(
    availabilityDraftIsDirty({ ...unrestricted, allowed: [KEY_A] }, unrestricted),
    false,
    "unrestricted の間は allowed を比較しない",
  );
  assert.equal(
    availabilityDraftIsDirty(
      { unrestricted: false, allowed: [KEY_B, KEY_A], defaultModel: null },
      { unrestricted: false, allowed: [KEY_A, KEY_B], defaultModel: null },
    ),
    false,
    "allowed の順序だけでは dirty にならない",
  );
  assert.equal(
    availabilityDraftIsDirty({ unrestricted: false, allowed: [], defaultModel: null }, unrestricted),
    true,
    "制限あり + 空配列は unrestricted へ正規化されても明示的な dirty とする",
  );
  assert.equal(
    availabilityDraftIsDirty({ ...unrestricted, defaultModel: KEY_A }, unrestricted),
    true,
    "既定モデルの差分も dirty とする",
  );
});

test("保存値の内容比較は新しい配列参照を無視し、要素の変更を検出する", () => {
  assert.equal(
    sameAvailabilitySettings(
      { allowedModels: [KEY_A, KEY_B], defaultModel: KEY_A },
      { allowedModels: [KEY_A, KEY_B], defaultModel: KEY_A },
    ),
    true,
  );
  assert.equal(
    sameAvailabilitySettings(
      { allowedModels: [KEY_A, KEY_B], defaultModel: KEY_A },
      { allowedModels: [KEY_A], defaultModel: KEY_A },
    ),
    false,
  );
  assert.equal(
    sameAvailabilitySettings(
      { allowedModels: [KEY_A], defaultModel: KEY_A },
      { allowedModels: [KEY_A], defaultModel: KEY_B },
    ),
    false,
  );
});

test("provider 単位の一括操作は全カタログ行を重複なく選び、解除時は既定を戻す", () => {
  const initial = { unrestricted: false, allowed: [KEY_A, KEY_C], defaultModel: KEY_B };
  const selected = setAvailabilityProviderModels(initial, "anthropic", true, CATALOG);
  assert.deepEqual(selected, {
    unrestricted: false,
    allowed: [KEY_A, KEY_C, KEY_B],
    defaultModel: KEY_B,
  });
  assert.equal(selected.allowed.filter((key) => key === KEY_B).length, 1, "利用不可のモデルも追加するが重複は作らない");

  assert.deepEqual(setAvailabilityProviderModels(selected, "anthropic", false, CATALOG), {
    unrestricted: false,
    allowed: [KEY_C],
    defaultModel: null,
  });
  assert.deepEqual(
    setAvailabilityProviderModels(initial, "unknown", true, CATALOG),
    initial,
    "モデル行の無い provider は変更しない",
  );
  const unrestricted = { unrestricted: true, allowed: [], defaultModel: null };
  assert.equal(setAvailabilityProviderModels(unrestricted, "anthropic", false, CATALOG), unrestricted);
});

test("既定モデルの選択肢はカタログ外の保存値も残し、ラベルで区別する", () => {
  const restricted = availabilityDefaultChoices(
    { unrestricted: false, allowed: [KEY_A, KEY_GHOST], defaultModel: KEY_GHOST },
    CATALOG,
  );
  assert.deepEqual(
    restricted.map((choice) => [choice.label, choice.available, choice.inCatalog]),
    [
      ["A（anthropic/a）", true, true],
      ["anthropic/ghost（カタログ外）", false, false],
    ],
  );
  const all = availabilityDefaultChoices({ unrestricted: true, allowed: [], defaultModel: null }, CATALOG);
  assert.deepEqual(
    all.map((choice) => choice.key),
    [KEY_A, KEY_B, KEY_C],
  );
});

test("保存の確認は利用可能 0 件と既定の未認証を伝える", () => {
  // すべて外した＝保存すると制限なしへ戻る
  assert.match(
    availabilityNotice({ unrestricted: false, allowed: [], defaultModel: null }, CATALOG).confirm ?? "",
    /制限なし（全モデル）へ戻ります/,
  );
  // 未認証のモデルだけを許可した＝利用可能 0 件
  const emptyAvailable = availabilityNotice({ unrestricted: false, allowed: [KEY_B], defaultModel: null }, CATALOG);
  assert.match(emptyAvailable.confirm ?? "", /利用可能なモデルが 0 件/);
  assert.equal(emptyAvailable.warning, undefined, "既定が未認証でなければ警告は出さない");

  // 既定が未認証なら警告を常時出し、確認にも含める
  const unauthenticatedDefault = availabilityNotice(
    { unrestricted: false, allowed: [KEY_A, KEY_B], defaultModel: KEY_B },
    CATALOG,
  );
  assert.match(unauthenticatedDefault.warning ?? "", /既定に選んだモデルは現在利用できません/);
  assert.match(unauthenticatedDefault.confirm ?? "", /既定に選んだモデルは現在利用できません/);
  // 利用可能な既定なら警告も確認も無い
  const ok = availabilityNotice({ unrestricted: false, allowed: [KEY_A], defaultModel: KEY_A }, CATALOG);
  assert.deepEqual(ok, {});
  // 制限なしなら全件が許可され、カタログに available がある限り確認は出ない
  assert.deepEqual(availabilityNotice({ unrestricted: true, allowed: [], defaultModel: null }, CATALOG), {});
  // カタログを取得できないときは判定しない (呼び出し側が編集自体を止める)
  assert.deepEqual(availabilityNotice({ unrestricted: false, allowed: [], defaultModel: null }, null), {});
});

test("利用可能なモデルの保存は確認を画面内で出し、同意したときだけ送る", () => {
  const notice = availabilityNotice({ unrestricted: false, allowed: [], defaultModel: null }, CATALOG);
  assert.equal(typeof notice.confirm, "string");
  assert.equal(availabilitySaveConfirmMessage(AVAILABILITY_SAVE_INITIAL, notice), undefined, "普段は確認を出さない");

  const first = availabilitySaveOnSubmit(AVAILABILITY_SAVE_INITIAL, notice);
  assert.deepEqual(first, { state: { confirming: true }, send: false }, "1 回目の押下では PUT を送らない");
  assert.equal(availabilitySaveConfirmMessage(first.state, notice), notice.confirm, "純関数の文言を画面内確認へ出す");

  const accepted = availabilitySaveOnSubmit(first.state, notice);
  assert.deepEqual(accepted, { state: AVAILABILITY_SAVE_INITIAL, send: true }, "同意した押下でだけ送る");
  assert.equal(availabilitySaveConfirmMessage(AVAILABILITY_SAVE_INITIAL, notice), undefined, "送ったら確認を閉じる");

  // 確認が不要な保存は 1 回目でそのまま送る
  assert.deepEqual(availabilitySaveOnSubmit(AVAILABILITY_SAVE_INITIAL, {}), {
    state: AVAILABILITY_SAVE_INITIAL,
    send: true,
  });
  // キャンセルは初期状態へ戻すだけ (コンポーネントはこの定数をセットし、PUT を送らない)
  assert.equal(AVAILABILITY_SAVE_INITIAL.confirming, false);
});
