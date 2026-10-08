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
  availabilityDraftState,
  availabilityNotice,
  availabilitySaveConfirmMessage,
  availabilitySaveOnSubmit,
  availableCountOf,
  candidateGroups,
  defaultModelOptions,
  degradedNotice,
  deleteConfirmRequest,
  filterCandidateGroups,
  filterDefaultModelOptions,
  groupProviders,
  MEMO_MAX_LENGTH,
  modelKeyProvider,
  modelRefKey,
  mutationNote,
  normalizeAllowedModels,
  providerAuthBadge,
  providerDraftBase,
  providerDraftOf,
  providerUsage,
  pruneAvailabilityDraft,
  resyncAvailable,
  sameAvailabilitySettings,
  setAvailabilityProviderModels,
  UNSET_DEFAULT_MODEL_LABEL,
  validateApiKey,
  validateMemo,
  withProviderDraft,
} from "../src/lib/modelSettings";
import type {
  ModelMutationResponse,
  ModelsSettingsResponse,
  ProviderAuthSetting,
  RuntimeModelsResponse,
  SessionSummary,
} from "../src/types";

function provider(overrides: Partial<ProviderAuthSetting> = {}): ProviderAuthSetting {
  return {
    provider: "anthropic",
    name: "Anthropic",
    auth: { configured: false, environmentVariables: [] },
    managed: false,
    keyUpdatedAt: null,
    canSetApiKey: true,
    supportsOAuth: false,
    orphan: false,
    memo: null,
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

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s1",
    title: "title",
    agentId: "agent-zundamon",
    status: "idle",
    queueDepth: 0,
    messageCount: 0,
    createdAt: 1,
    lastUsedAt: 2,
    pinned: false,
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
      provider({ provider: "managed-stamped", managed: true, keyUpdatedAt: 123 }),
      provider({ provider: "memo-only", memo: "個人アカウントの控え" }),
      provider({ provider: "anthropic", auth: { configured: false, environmentVariables: [] } }),
      provider({ provider: "unset-b", orphan: true }),
    ],
  });
  const groups = groupProviders(configured, CATALOG);
  assert.deepEqual(
    groups.configured.map((entry) => entry.provider),
    ["configured-env", "managed", "managed-stamped", "memo-only", "anthropic"],
    "カタログに available があるか、メモがある provider は設定済みとして先頭に置く",
  );
  assert.deepEqual(
    groups.unconfigured.map((entry) => entry.provider),
    ["unset-a", "unset-b"],
  );
  assert.equal(availableCountOf(CATALOG, "anthropic"), 1);
  assert.equal(availableCountOf(CATALOG, "unknown"), 0);
  assert.equal(availableCountOf(null, "anthropic"), 0);
  // メモだけの provider もカタログ無しで設定済み側へ出す (折りたたみに隠れない)
  const memoOnly = groupProviders(settings({ providers: [provider({ provider: "memo-only", memo: "控え" })] }), null);
  assert.deepEqual(
    memoOnly.configured.map((entry) => entry.provider),
    ["memo-only"],
  );
});

test("providerUsage は model の最初の / で provider を分け、会話数と最新の最終使用を返す", () => {
  const sessions = [
    session({ sessionId: "a", model: "anthropic/claude-sonnet", lastUsedAt: 100 }),
    session({ sessionId: "b", model: "anthropic/claude-haiku", lastUsedAt: 300 }),
    // model id に / を含んでも provider は先頭だけを見る (openrouter のモデル)
    session({ sessionId: "c", model: "openrouter/anthropic/claude", lastUsedAt: 999 }),
    session({ sessionId: "d", model: "openai/gpt-5", lastUsedAt: 400 }),
    // model の無い会話は母数から除く
    session({ sessionId: "e", lastUsedAt: 500 }),
  ];
  assert.deepEqual(providerUsage(sessions, "anthropic"), { sessions: 2, lastUsedAt: 300 });
  assert.deepEqual(providerUsage(sessions, "openrouter"), { sessions: 1, lastUsedAt: 999 });
  assert.deepEqual(providerUsage(sessions, "openai"), { sessions: 1, lastUsedAt: 400 });
  assert.deepEqual(providerUsage(sessions, "ghost"), { sessions: 0, lastUsedAt: null });
  // 壊れた model は数えない (provider も id も空にできない)
  assert.deepEqual(providerUsage([session({ model: "anthropic/" }), session({ model: "/claude" })], "anthropic"), {
    sessions: 0,
    lastUsedAt: null,
  });
  assert.deepEqual(providerUsage([], "anthropic"), { sessions: 0, lastUsedAt: null });
});

test("provider の入力下書きはフィールド単位で、未編集の provider は保存値を使う", () => {
  const saved = provider({ memo: "個人アカウントの控え" });
  const base = providerDraftBase(saved);
  assert.deepEqual(providerDraftOf({}, saved), { apiKey: "", memo: "個人アカウントの控え" });

  let drafts = withProviderDraft({}, "anthropic", base, { apiKey: "sk-live", memo: "編集中" });
  // 保存値の再取得や別 provider の追加があっても、編集中の下書きをそのまま返す (再マウントで復元する値)
  assert.deepEqual(providerDraftOf(drafts, saved), { apiKey: "sk-live", memo: "編集中" });
  assert.deepEqual(providerDraftOf(drafts, provider({ memo: "別の控え" })), { apiKey: "sk-live", memo: "編集中" });
  assert.deepEqual(providerDraftOf(drafts, provider({ provider: "openai", name: "OpenAI" })), {
    apiKey: "",
    memo: "",
  });

  // 更新は provider ごとに独立し、内容が同じなら同じ参照を返す (base はその provider の保存値)
  assert.equal(withProviderDraft(drafts, "anthropic", base, { apiKey: "sk-live", memo: "編集中" }), drafts);
  drafts = withProviderDraft(drafts, "openai", providerDraftBase(provider({ provider: "openai", name: "OpenAI" })), {
    apiKey: "sk-other",
  });
  assert.deepEqual(drafts, {
    anthropic: { apiKey: "sk-live", memo: "編集中" },
    openai: { apiKey: "sk-other", memo: "" },
  });
});

test("保存完了と保存値の同期はフィールド単位で更新し、待機中の他方の入力を残す", () => {
  const base = providerDraftBase(provider());
  // キー保存: 押下後、保存の待機中にメモを編集 → 完了後も新しいメモが残る
  let drafts = withProviderDraft({}, "anthropic", base, { apiKey: "sk-live" });
  drafts = withProviderDraft(drafts, "anthropic", base, { memo: "待機中に書いたメモ" });
  drafts = withProviderDraft(drafts, "anthropic", base, { apiKey: "" });
  assert.deepEqual(providerDraftOf(drafts, provider()), { apiKey: "", memo: "待機中に書いたメモ" });

  // メモ保存: 押下後、保存の待機中にキーを編集 → 完了後も新しいキーが残る
  drafts = withProviderDraft(drafts, "anthropic", base, { memo: "  メモ  " });
  drafts = withProviderDraft(drafts, "anthropic", base, { apiKey: "sk-next" });
  drafts = withProviderDraft(drafts, "anthropic", base, { memo: "メモ" });
  assert.deepEqual(providerDraftOf(drafts, provider()), { apiKey: "sk-next", memo: "メモ" });

  // 保存値の外部変化 (useEffect) は memo だけを合わせ、入力中の apiKey を巻き戻さない
  drafts = withProviderDraft(drafts, "anthropic", base, { memo: "外部の新しいメモ" });
  assert.deepEqual(providerDraftOf(drafts, provider()), { apiKey: "sk-next", memo: "外部の新しいメモ" });
});

test("APIキーの長さはサーバーと同じ境界で検証する", () => {
  assert.equal(validateApiKey("a".repeat(API_KEY_MIN_LENGTH - 1)), "APIキーは 8 文字以上で入力してください。");
  assert.equal(validateApiKey("a".repeat(API_KEY_MIN_LENGTH)), undefined);
  assert.equal(validateApiKey("a".repeat(API_KEY_MAX_LENGTH)), undefined);
  assert.equal(validateApiKey("a".repeat(API_KEY_MAX_LENGTH + 1)), "APIキーは 2048 文字以内で入力してください。");
});

test("メモは上限だけを検証し、空文字はクリアとして通す", () => {
  // 空は「行を消して未設定へ戻す」なのでエラーにしない
  assert.equal(validateMemo(""), undefined);
  assert.equal(validateMemo("個人アカウントの控え"), undefined);
  assert.equal(validateMemo("a".repeat(MEMO_MAX_LENGTH)), undefined);
  assert.equal(validateMemo("a".repeat(MEMO_MAX_LENGTH + 1)), `メモは ${MEMO_MAX_LENGTH} 文字以内で入力してください。`);
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
  // メモは SDK に触れないため applied_unsynced は来ない。空で保存したときだけ文言を分ける
  assert.deepEqual(mutationNote("memo", applied), { text: "メモを保存しました。", error: false });
  assert.deepEqual(mutationNote("memo", applied, true), { text: "メモを消しました。", error: false });
});

test("削除の確認は既存会話への影響を伝える", () => {
  const request = deleteConfirmRequest("Anthropic");
  assert.deepEqual(request.subject, { label: "削除する provider", value: "Anthropic" });
  const body = request.body?.join("\n") ?? "";
  assert.match(body, /未ロードの会話/);
  assert.match(body, /auth\.json/);
  assert.equal(request.confirmLabel, "削除する");
  assert.ok(request.danger, "キー削除は danger にする");
});

// --- 利用可能なモデル（許可リスト）と既定モデルの編集 ---

// API の allowedModels と同じ "provider/model" の表記
const KEY_A = "anthropic/a";
const KEY_B = "anthropic/b";
const KEY_C = "local/c";
const KEY_GHOST = "anthropic/ghost";

test("保存値から下書きを作り、null は利用可能な全モデルを選択済みとして明示リストへ展開する", () => {
  assert.deepEqual(availabilityDraftFromSettings(settings(), CATALOG), {
    allowed: [KEY_A],
    defaultModel: null,
  });
  // 既定モデルが available の集合に無い場合は 1 件足す (別の差分の保存を 400 にしない)
  assert.deepEqual(availabilityDraftFromSettings(settings({ defaultModel: KEY_B }), CATALOG), {
    allowed: [KEY_A, KEY_B],
    defaultModel: KEY_B,
  });
  // カタログを取得できないときは空になるが、既定だけは表示集合に残す
  assert.deepEqual(availabilityDraftFromSettings(settings({ defaultModel: KEY_GHOST }), null), {
    allowed: [KEY_GHOST],
    defaultModel: KEY_GHOST,
  });
  // 明示リストは available でない選択も保存値のまま保つ (provider が認証済みなら候補に出る)
  assert.deepEqual(availabilityDraftFromSettings(settings({ allowedModels: [KEY_B], defaultModel: KEY_B }), CATALOG), {
    allowed: [KEY_B],
    defaultModel: KEY_B,
  });
  // 認証の無い provider の選択と、それを指す既定は下書きから落とす (画面に出ない値を保存しない)
  assert.deepEqual(
    availabilityDraftFromSettings(settings({ allowedModels: [KEY_A, KEY_C], defaultModel: KEY_C }), CATALOG),
    { allowed: [KEY_A], defaultModel: null },
  );
  // カタログ外の残存エントリは、認証が無くても外せるように残す
  assert.deepEqual(
    availabilityDraftFromSettings(settings({ allowedModels: [KEY_C, KEY_GHOST], defaultModel: null }), CATALOG),
    { allowed: [KEY_GHOST], defaultModel: null },
  );
});

test("下書きの除去は表示と同じ判定で認証済み provider とカタログ外だけを残し、変化が無ければ同じ参照を返す", () => {
  const draft = { allowed: [KEY_A, KEY_B, KEY_C, KEY_GHOST], defaultModel: KEY_C };
  assert.deepEqual(pruneAvailabilityDraft(draft, CATALOG), {
    allowed: [KEY_A, KEY_B, KEY_GHOST],
    defaultModel: null,
  });
  // 既定が残る選択を指すなら保つ
  assert.deepEqual(pruneAvailabilityDraft({ ...draft, defaultModel: KEY_A }, CATALOG).defaultModel, KEY_A);
  // カタログが無いときは判定できないのでそのまま
  assert.equal(pruneAvailabilityDraft(draft, null), draft);
  // 落とすものが無ければ参照を変えない (そのまま再レンダーさせない)
  const clean = { allowed: [KEY_A], defaultModel: KEY_A };
  assert.equal(pruneAvailabilityDraft(clean, CATALOG), clean);
});

test("下書きの比較基準はカタログの更新では作り直さず、保存値と初回のカタログ到着でだけ作り直す", () => {
  const nullSettings = { allowedModels: null, defaultModel: null };
  // カタログ取得前は空。カタログつきで作った印は false
  const pending = availabilityDraftState(null, nullSettings, null);
  assert.deepEqual(pending.initial, { allowed: [], defaultModel: null });
  assert.equal(pending.builtWithCatalog, false);
  // カタログが届いたら 1 回だけ展開する
  const expanded = availabilityDraftState(pending, nullSettings, CATALOG);
  assert.notEqual(expanded, pending);
  assert.deepEqual(expanded.initial.allowed, [KEY_A], "available の全件を選択済みにする");
  assert.equal(expanded.builtWithCatalog, true);

  // 明示リストもカタログ取得前に作った初期値は、カタログの到着で 1 回だけ除去して作り直す
  const listPending = availabilityDraftState(null, { allowedModels: [KEY_C, KEY_A], defaultModel: null }, null);
  assert.deepEqual(listPending.initial, { allowed: [KEY_C, KEY_A], defaultModel: null });
  assert.equal(listPending.builtWithCatalog, false);
  const listBuilt = availabilityDraftState(listPending, listPending.settings, CATALOG);
  assert.notEqual(listBuilt, listPending);
  assert.deepEqual(listBuilt.initial, { allowed: [KEY_A], defaultModel: null });
  assert.equal(listBuilt.builtWithCatalog, true);

  // キー登録でカタログに新しい provider が増えても、比較基準は作り直さない (編集中の下書きを置換しない)
  const grown: RuntimeModelsResponse = {
    ...CATALOG,
    providers: [
      ...CATALOG.providers,
      {
        provider: "b",
        auth: { configured: true, source: "environment", environmentVariables: [] },
        models: [{ id: "three", name: "Three", available: true }],
      },
    ],
  };
  assert.equal(availabilityDraftState(expanded, nullSettings, grown), expanded);
  assert.equal(availabilityDraftState(listBuilt, listBuilt.settings, grown), listBuilt);
  // 再取得に失敗してカタログを失っても作り直さない
  assert.equal(availabilityDraftState(expanded, nullSettings, null), expanded);
  // 保存値が変わったら作り直す
  const saved = { allowedModels: [KEY_B], defaultModel: KEY_B };
  const next = availabilityDraftState(expanded, saved, grown);
  assert.notEqual(next, expanded);
  assert.deepEqual(next.initial, { allowed: [KEY_B], defaultModel: KEY_B });

  // 明示リストのときもカタログの更新では作り直さない
  const listSettings = { allowedModels: [KEY_A], defaultModel: null };
  const listState = availabilityDraftState(null, listSettings, CATALOG);
  assert.equal(availabilityDraftState(listState, listSettings, grown), listState);
});

test("明示リストの正規化は空だけを null へ寄せ、全選択でもリストを返す", () => {
  assert.equal(normalizeAllowedModels([]), null);
  assert.deepEqual(normalizeAllowedModels([KEY_A]), [KEY_A]);
  assert.deepEqual(
    normalizeAllowedModels([KEY_A, KEY_B, KEY_C]),
    [KEY_A, KEY_B, KEY_C],
    "全チェックでも明示リストを送る (空への安全網はあるが、UI からは空を送らない)",
  );
  assert.equal(modelRefKey({ provider: "anthropic", id: "a" }), KEY_A);
  assert.equal(modelKeyProvider("openrouter/anthropic/claude"), "openrouter", "provider は最初の / まで");
});

test("カタログ外の残存エントリを分ける", () => {
  assert.deepEqual(allowedModelsOutsideCatalog([KEY_A, KEY_GHOST], CATALOG), [KEY_GHOST]);
  assert.deepEqual(allowedModelsOutsideCatalog([KEY_A], null), [KEY_A]);
});

test("候補は認証済み provider のカタログ全件とカタログ外の残存だけで、認証の無い provider は出さない", () => {
  const groups = candidateGroups({ allowed: [KEY_C, KEY_GHOST], defaultModel: null }, CATALOG, settings());
  assert.deepEqual(
    groups.map((group) => [group.provider, group.authenticated]),
    [["anthropic", true]],
    "下書きに残っていても未認証 provider の選択は出さない (表示と保存の対象を揃える)",
  );
  const anthropic = groups[0];
  assert.deepEqual(
    anthropic.rows.map((row) => [row.key, row.checked, row.available, row.outsideCatalog]),
    [
      [KEY_A, false, true, false],
      [KEY_B, false, false, false],
      [KEY_GHOST, true, false, true],
    ],
    "カタログ全件に加えて、カタログ外の選択済みをチェック済みで足す",
  );
  assert.match(anthropic.warning ?? "", /カタログに無いモデル/);

  // カタログ外の残存エントリは、認証の無い provider でも外せるように警告付きで出す
  const staleLocal = candidateGroups({ allowed: [KEY_C, "local/ghost"], defaultModel: null }, CATALOG, settings());
  const local = staleLocal.find((group) => group.provider === "local");
  assert.deepEqual(
    local?.rows.map((row) => row.key),
    ["local/ghost"],
    "カタログにあるが認証の無い provider は、カタログ外の保存済みだけを出す",
  );
  assert.match(local?.warning ?? "", /認証が設定されていない/);
  assert.equal(local?.authenticated, false);
  assert.equal(local?.selectedCount, 2, "provider 行の選択数は下書きから数える");

  // カタログ外の provider は選択を外せるように警告付きで出す
  const unknown = candidateGroups({ allowed: ["unknown/x"], defaultModel: null }, CATALOG, settings());
  assert.deepEqual(
    unknown.map((group) => [group.provider, group.authenticated, group.rows.map((row) => row.key)]),
    [
      ["anthropic", true, [KEY_A, KEY_B]],
      ["unknown", false, ["unknown/x"]],
    ],
    "認証済み provider を先に、カタログ外の provider を後ろに足す",
  );
  assert.match(unknown[1].warning ?? "", /カタログに無い provider/);
  // カタログにも下書きにも無い provider は行に出ない
  assert.equal(
    groups.some((group) => group.provider === "unknown"),
    false,
  );
});

test("候補の並びはカタログ順で、プロバイダー一覧と同じ順を保つ", () => {
  const catalog: RuntimeModelsResponse = {
    ...CATALOG,
    providers: [
      {
        provider: "first",
        auth: { configured: true, source: "environment", environmentVariables: [] },
        models: [{ id: "a", name: "A", available: true }],
      },
      {
        provider: "second",
        auth: { configured: true, source: "environment", environmentVariables: [] },
        models: [
          { id: "a", name: "A", available: true },
          { id: "b", name: "B", available: true },
          { id: "c", name: "C", available: false },
        ],
      },
      {
        provider: "third",
        auth: { configured: true, source: "environment", environmentVariables: [] },
        models: [{ id: "a", name: "A", available: false }],
      },
    ],
  };
  const groups = candidateGroups({ allowed: [], defaultModel: null }, catalog, settings());
  assert.deepEqual(
    groups.map((group) => [group.provider, group.rows.length]),
    [
      ["first", 1],
      ["second", 3],
      ["third", 1],
    ],
    "利用不可の行も group に含め、利用可能数の多い provider を先頭に動かさない",
  );
});

test("検索は provider / モデル名 / ID に当たり、選択済みのみで絞る", () => {
  const groups = candidateGroups({ allowed: [KEY_A], defaultModel: null }, CATALOG, settings());
  assert.deepEqual(
    filterCandidateGroups(groups, "ANTHROPIC", false).map((group) => [group.provider, group.rows.length]),
    [["anthropic", 2]],
    "provider 名 / ID は大文字小文字を無視して provider 全件に当てる",
  );
  assert.deepEqual(
    filterCandidateGroups(groups, "anthropic/b", false).map((group) => group.rows.map((row) => row.key)),
    [[KEY_B]],
    "モデル名 / ID で行を絞る",
  );
  assert.deepEqual(
    filterCandidateGroups(groups, "", true).map((group) => group.rows.map((row) => row.key)),
    [[KEY_A]],
    "選択済みのみはチェック済みの行だけを残す",
  );
  assert.deepEqual(filterCandidateGroups(groups, "missing", false), [], "当たらない provider は残さない");

  const withLocal = candidateGroups({ allowed: [KEY_C], defaultModel: null }, CATALOG, settings());
  assert.deepEqual(
    filterCandidateGroups(withLocal, "local", false),
    [],
    "認証の無い provider は検索でも出さない (検索だけが見えない選択を掘り起こさない)",
  );
  const withStale = candidateGroups({ allowed: ["local/ghost"], defaultModel: null }, CATALOG, settings());
  assert.deepEqual(
    filterCandidateGroups(withStale, "local", false).map((group) => group.rows.map((row) => row.key)),
    [["local/ghost"]],
    "カタログ外の残存は検索でも出して外せる",
  );
});

test("集計は表示集合の利用可能数と選択数を返す", () => {
  const groups = candidateGroups({ allowed: [KEY_A, KEY_C], defaultModel: null }, CATALOG, settings());
  assert.deepEqual(
    availabilityCounts(groups),
    { available: 1, selected: 1 },
    "認証の無い provider の選択は表示集合に無いので数えない",
  );
  assert.deepEqual(availabilityCounts([]), { available: 0, selected: 0 });
});

test("下書きの未保存判定は選択を集合として比べ、並び順だけの違いは無視する", () => {
  const initial = { allowed: [KEY_A, KEY_B], defaultModel: KEY_A };
  assert.equal(
    availabilityDraftIsDirty({ ...initial, allowed: [KEY_B, KEY_A] }, initial),
    false,
    "並び順だけでは dirty にならない",
  );
  assert.equal(availabilityDraftIsDirty({ ...initial, allowed: [KEY_A] }, initial), true, "選択の増減は dirty");
  assert.equal(availabilityDraftIsDirty({ ...initial, defaultModel: null }, initial), true, "既定モデルの差分も dirty");
  assert.equal(availabilityDraftIsDirty(initial, initial), false);
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

test("provider 単位の一括操作は全カタログ行を重複なく選び、解除では保存済みを外して既定を戻す", () => {
  const initial = { allowed: [KEY_A, KEY_C], defaultModel: KEY_B };
  const selected = setAvailabilityProviderModels(initial, "anthropic", true, CATALOG);
  assert.deepEqual(selected, { allowed: [KEY_A, KEY_C, KEY_B], defaultModel: KEY_B });
  assert.equal(selected.allowed.filter((key) => key === KEY_B).length, 1, "利用不可のモデルも追加するが重複は作らない");

  assert.deepEqual(setAvailabilityProviderModels(selected, "anthropic", false, CATALOG), {
    allowed: [KEY_C],
    defaultModel: null,
  });
  assert.deepEqual(
    setAvailabilityProviderModels(initial, "unknown", true, CATALOG),
    initial,
    "カタログに無い provider は追加できない",
  );
  // [すべて解除] はカタログに無い provider でも、下書きの全エントリを外せる
  const orphan = { allowed: ["ghost/x", "ghost/y"], defaultModel: "ghost/x" };
  assert.deepEqual(setAvailabilityProviderModels(orphan, "ghost", false, CATALOG), {
    allowed: [],
    defaultModel: null,
  });
});

test("既定モデルの選択肢は選択済みだけをカタログの名前つきで返し、カタログ外も残す", () => {
  const choices = availabilityDefaultChoices({ allowed: [KEY_A, KEY_GHOST], defaultModel: KEY_GHOST }, CATALOG);
  assert.deepEqual(choices, [
    { key: KEY_A, name: "A", available: true, inCatalog: true },
    { key: KEY_GHOST, name: KEY_GHOST, available: false, inCatalog: false },
  ]);
  assert.deepEqual(availabilityDefaultChoices({ allowed: [], defaultModel: null }, CATALOG), []);
});

test("既定モデルのピッカーは「未設定」を先頭に残し、名前 / ID で検索する", () => {
  const options = defaultModelOptions({ allowed: [KEY_B, KEY_GHOST], defaultModel: KEY_GHOST }, CATALOG);
  assert.deepEqual(
    options.map((option) => [option.key, option.name, option.detail, option.inCatalog]),
    [
      [null, UNSET_DEFAULT_MODEL_LABEL, "", true],
      [KEY_B, "B", KEY_B, true],
      [KEY_GHOST, KEY_GHOST, KEY_GHOST, false],
    ],
  );
  assert.deepEqual(filterDefaultModelOptions(options, ""), options, "未入力では全件を出す");
  assert.deepEqual(
    filterDefaultModelOptions(options, "ghost").map((option) => option.key),
    [KEY_GHOST],
  );
  assert.deepEqual(
    filterDefaultModelOptions(options, "未設定").map((option) => option.key),
    [null],
    "「未設定」の語でも絞り込める",
  );
  assert.deepEqual(filterDefaultModelOptions(options, "missing"), []);
});

test("保存の確認は利用可能 0 件と既定の未認証を伝え、選択 0 件の理由は扱わない", () => {
  // 選択 0 件はコンポーネントが保存自体を止めるため、ここでは確認を出さない
  assert.deepEqual(availabilityNotice({ allowed: [], defaultModel: null }, CATALOG), {});
  // 未認証のモデルだけを選択した＝利用可能 0 件
  const emptyAvailable = availabilityNotice({ allowed: [KEY_B], defaultModel: null }, CATALOG);
  assert.match(emptyAvailable.confirm ?? "", /利用可能なモデルが 0 件/);
  assert.equal(emptyAvailable.warning, undefined, "既定が未認証でなければ警告は出さない");

  // 既定が未認証なら警告を常時出し、確認にも含める
  const unauthenticatedDefault = availabilityNotice({ allowed: [KEY_A, KEY_B], defaultModel: KEY_B }, CATALOG);
  assert.match(unauthenticatedDefault.warning ?? "", /既定に選んだモデルは現在利用できません/);
  assert.match(unauthenticatedDefault.confirm ?? "", /既定に選んだモデルは現在利用できません/);
  // 利用可能な選択と既定なら警告も確認も無い
  assert.deepEqual(availabilityNotice({ allowed: [KEY_A], defaultModel: KEY_A }, CATALOG), {});
  // カタログを取得できないときは判定しない (呼び出し側が編集自体を止める)
  assert.deepEqual(availabilityNotice({ allowed: [KEY_B], defaultModel: null }, null), {});
});

test("利用可能なモデルの保存は確認を画面内で出し、同意したときだけ送る", () => {
  const notice = availabilityNotice({ allowed: [KEY_B], defaultModel: null }, CATALOG);
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
