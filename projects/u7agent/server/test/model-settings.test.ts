// 設定 → モデル (プロバイダー API キー) のサービス契約。実 API は呼ばず、fake の ProviderKeyRuntime / DB で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { createSecretMasker } from "../src/redact";
import type { ModelCatalogRefreshAttempt } from "../src/agent";
import {
  MODEL_CATALOG_ERROR_OFFLINE,
  MODEL_CATALOG_ERROR_PARTIAL,
  MODEL_CATALOG_ERROR_TIMEOUT,
  MODEL_CATALOG_ERROR_UNKNOWN,
  MODEL_SELECTION_DEFAULT_NOT_ALLOWED_MESSAGE,
  MODEL_SELECTION_FORMAT_MESSAGE,
  MODEL_SELECTION_NOT_IN_CATALOG_MESSAGE,
  MODEL_SELECTION_NOT_STORED_MESSAGE,
  MODEL_SELECTION_RUNTIME_UNAVAILABLE_MESSAGE,
  ModelSettingsService,
  PROVIDER_KEY_NOT_MANAGED_MESSAGE,
  PROVIDER_KEY_RUNTIME_UNAVAILABLE_MESSAGE,
  PROVIDER_MEMO_NOT_STORED_MESSAGE,
  PROVIDER_MEMO_RUNTIME_UNAVAILABLE_MESSAGE,
  PROVIDER_MEMO_TARGET_MESSAGE,
  PROVIDER_RESYNC_TARGET_MESSAGE,
  type CredentialCommit,
  type CatalogRefreshOutcome,
  type ModelSettingsDb,
  type MutationOutcome,
  type ProviderKeyRuntime,
  type StoredModelSelection,
} from "../src/model-settings";
import {
  PROVIDER_API_KEY_MIN_LENGTH,
  RUNTIME_MODELS_UNAVAILABLE_MESSAGE,
  type ModelRef,
  type RuntimeModelsResponse,
} from "../src/schema";

const KEY_A = "sk-ant-dummy-key-a-0123456789";
const KEY_B = "sk-openai-dummy-key-b-0123456789";

interface FakeProvider {
  provider: string;
  name?: string;
  canSetApiKey?: boolean;
  supportsOAuth?: boolean;
  configured?: boolean;
  authSource?: string;
}

interface RuntimeCall {
  operation: "apply" | "remove";
  provider: string;
  apiKey?: string;
  aborted: boolean;
}

/** カタログ更新の呼び出し。実 SDK へ渡す契約 (allowNetwork / force) を検証できるようにする */
interface CatalogRefreshCall {
  allowNetwork: boolean;
  force: boolean;
  aborted: boolean;
}

/** GET /api/runtime/models と カタログ更新 が返すデフォルトのスナップショット。実 API の形を最小で満たす */
const CATALOG_SNAPSHOT: RuntimeModelsResponse = {
  catalogCount: 1,
  availableCount: 1,
  versions: { piCodingAgent: "1.0.0" },
  providers: [
    {
      provider: "anthropic",
      auth: { configured: true, source: "environment", environmentVariables: [] },
      models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", available: true }],
    },
  ],
};

/** SDK 面の fake。apply / remove / カタログ更新の実装だけテストごとに差し替え、呼び出しを記録する */
function fakeRuntime(
  options: {
    providers?: FakeProvider[];
    catalog?: ModelRef[];
    /** null = `GET /api/runtime/models` と同じく一覧を返せない状態。未指定は既定のスナップショット */
    catalogSnapshot?: RuntimeModelsResponse | null;
    refreshCatalog?: (options: {
      allowNetwork: boolean;
      force: boolean;
      signal: AbortSignal;
    }) => ModelCatalogRefreshAttempt | Promise<ModelCatalogRefreshAttempt>;
    apply?: (provider: string, apiKey: string, signal: AbortSignal) => CredentialCommit | Promise<CredentialCommit>;
    remove?: (provider: string, signal: AbortSignal) => CredentialCommit | Promise<CredentialCommit>;
  } = {},
) {
  const providers = options.providers ?? [{ provider: "anthropic", configured: true }];
  const configured = new Map(providers.map((entry) => [entry.provider, entry.configured ?? false]));
  const calls: RuntimeCall[] = [];
  const catalogRefreshCalls: CatalogRefreshCall[] = [];
  const runtime: ProviderKeyRuntime = {
    list: () =>
      providers.map((entry) => ({
        provider: entry.provider,
        name: entry.name ?? entry.provider,
        canSetApiKey: entry.canSetApiKey ?? true,
        supportsOAuth: entry.supportsOAuth ?? false,
      })),
    auth: (provider) => {
      const entry = providers.find((candidate) => candidate.provider === provider);
      if (!entry) return { configured: false };
      return configured.get(provider)
        ? { configured: true, source: entry.authSource ?? "environment" }
        : { configured: false };
    },
    catalog: () => options.catalog ?? [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    refreshCatalog: async (refreshOptions) => {
      catalogRefreshCalls.push({
        allowNetwork: refreshOptions.allowNetwork,
        force: refreshOptions.force,
        aborted: refreshOptions.signal.aborted,
      });
      // 実 SDK と同じく、開始前に abort 済みなら通信せず aborted で返す
      if (refreshOptions.signal.aborted) return { aborted: true, failedProviders: 0 };
      return options.refreshCatalog ? options.refreshCatalog(refreshOptions) : { aborted: false, failedProviders: 0 };
    },
    // 既存の fake は「カタログがある」を既定にし、null を明示したときだけ 503 経路を作る
    catalogSnapshot: () =>
      options.catalogSnapshot === null ? undefined : (options.catalogSnapshot ?? CATALOG_SNAPSHOT),
    applyApiKey: async (provider, apiKey, { signal }) => {
      calls.push({ operation: "apply", provider, apiKey, aborted: signal.aborted });
      const commit = options.apply
        ? await options.apply(provider, apiKey, signal)
        : ({ outcome: "applied", synced: true } as CredentialCommit);
      if (commit.outcome === "applied") configured.set(provider, true);
      return commit;
    },
    removeApiKey: async (provider, { signal }) => {
      calls.push({ operation: "remove", provider, aborted: signal.aborted });
      const commit = options.remove
        ? await options.remove(provider, signal)
        : ({ outcome: "applied", synced: true } as CredentialCommit);
      if (commit.outcome === "applied") configured.set(provider, false);
      return commit;
    },
  };
  return { runtime, providers, calls, catalogRefreshCalls, configured };
}

/** DB 面の fake。失敗フラグで AppDb の失敗経路を再現する */
function fakeDb(rows: Record<string, string> = {}, selection?: StoredModelSelection) {
  const store = new Map(Object.entries(rows));
  // API キーの行と保存日時を分ける。移行前の既存行は日時不明 (null) で始まる
  const updatedAtStore = new Map<string, number | null>(Object.keys(rows).map((provider) => [provider, null]));
  const memos = new Map<string, string>();
  const state = {
    failList: false,
    failGet: false,
    failSave: false,
    failDelete: false,
    failReadSelection: false,
    failSaveSelection: false,
    failListMemos: false,
    failGetMemo: false,
    failSaveMemo: false,
    failDeleteMemo: false,
    /** 保存は成功させるが、以後の一覧読みを失敗させる (DTO 組み立てだけが壊れる経路) */
    armListFailureOnSave: false,
    /** 削除は成功させるが、以後の一覧読みを失敗させる (DELETE だけが DTO を組めない経路) */
    armListFailureOnDelete: false,
    /** メモ保存は成功させるが、以後のメモ一覧読みを失敗させる */
    armListFailureOnSaveMemo: false,
    error: new Error("sqlite failure"),
  };
  // 行の有無 = 未設定を保つため、両方 null の保存は行ごと消す (AppDb と同じ正規化)
  let saved: StoredModelSelection | undefined = selection;
  const db: ModelSettingsDb = {
    listProviderCredentials: () => {
      if (state.failList) throw state.error;
      return [...store].map(([provider, apiKey]) => ({
        provider,
        apiKey,
        updatedAt: updatedAtStore.get(provider) ?? null,
      }));
    },
    getProviderCredential: (provider) => {
      if (state.failGet) throw state.error;
      const apiKey = store.get(provider);
      return apiKey === undefined ? undefined : { provider, apiKey, updatedAt: updatedAtStore.get(provider) ?? null };
    },
    saveProviderCredential: (provider, apiKey, updatedAt) => {
      if (state.failSave) throw state.error;
      store.set(provider, apiKey);
      updatedAtStore.set(provider, updatedAt);
      if (state.armListFailureOnSave) state.failList = true;
    },
    deleteProviderCredential: (provider) => {
      if (state.failDelete) throw state.error;
      const deleted = store.delete(provider);
      updatedAtStore.delete(provider);
      if (state.armListFailureOnDelete) state.failList = true;
      return deleted;
    },
    listProviderMemos: () => {
      if (state.failListMemos) throw state.error;
      return [...memos].map(([provider, memo]) => ({ provider, memo }));
    },
    getProviderMemo: (provider) => {
      if (state.failGetMemo) throw state.error;
      const memo = memos.get(provider);
      return memo === undefined ? undefined : { provider, memo };
    },
    saveProviderMemo: (provider, memo) => {
      if (state.failSaveMemo) throw state.error;
      memos.set(provider, memo);
      if (state.armListFailureOnSaveMemo) state.failListMemos = true;
    },
    deleteProviderMemo: (provider) => {
      if (state.failDeleteMemo) throw state.error;
      return memos.delete(provider);
    },
    readModelSettings: () => {
      if (state.failReadSelection) throw state.error;
      return saved;
    },
    saveModelSettings: (next) => {
      if (state.failSaveSelection) throw state.error;
      saved = next.allowedModels || next.defaultModel ? next : undefined;
    },
  };
  return {
    db,
    store,
    updatedAtStore,
    memos,
    state,
    readSelection: () => saved,
  };
}

function createService(options: {
  db: ModelSettingsDb;
  runtime: ProviderKeyRuntime | null;
  retained?: string[];
  log?: string[];
  refresh?: () => Promise<void>;
  masker?: (text: string) => string;
  ignoredEnvironmentVariables?: string[];
  catalogTimeoutMs?: number;
}) {
  const retained = options.retained ?? [];
  const refreshes: number[] = [];
  const selections: { allowedModels: ModelRef[] | undefined; defaultModel: ModelRef | undefined }[] = [];
  // setter と refresh の順序を検証できるよう、別のログへ積む
  const events: string[] = [];
  const service = new ModelSettingsService({
    db: options.db,
    runtime: options.runtime,
    retainSecret: (value) => {
      // 適用との順序を検証できるよう、同じログへ積む
      options.log?.push(`retain:${value}`);
      retained.push(value);
    },
    maskError: (text) => options.masker?.(text) ?? text,
    refreshModelState: async () => {
      events.push("refresh");
      refreshes.push(1);
      await options.refresh?.();
    },
    setModelSelection: (selection) => {
      events.push("set");
      selections.push(selection);
    },
    ignoredEnvironmentVariables: options.ignoredEnvironmentVariables ?? [],
    ...(options.catalogTimeoutMs !== undefined ? { catalogTimeoutMs: options.catalogTimeoutMs } : {}),
  });
  return { service, retained, refreshCount: () => refreshes.length, selections, events };
}

function okBody(outcome: MutationOutcome) {
  if (outcome.status !== 200) throw new Error(`expected 200, got ${outcome.status}: ${outcome.error}`);
  return outcome.response;
}

function errorOf(outcome: MutationOutcome) {
  if (outcome.status !== 503) throw new Error(`expected 503, got ${outcome.status}`);
  return outcome.error;
}

async function captureConsole<T>(run: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const original = { warn: console.warn, error: console.error };
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    return { value: await run(), logs };
  } finally {
    console.warn = original.warn;
    console.error = original.error;
  }
}

test("GET はキー値を返さず、managed / canSetApiKey / orphan / degraded を出し分ける", async () => {
  const db = fakeDb({ anthropic: KEY_A, "legacy-orphan": KEY_B });
  const runtime = fakeRuntime({
    providers: [
      { provider: "anthropic", name: "Anthropic", configured: true },
      { provider: "openai", name: "OpenAI", canSetApiKey: false, supportsOAuth: true },
    ],
  });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const response = service.settings();
  assert.equal(response.runtimeAvailable, true);
  assert.equal(response.defaultModel, null);
  assert.equal(response.allowedModels, null);
  assert.deepEqual(response.ignoredEnvironmentVariables, []);
  const byProvider = new Map(response.providers.map((provider) => [provider.provider, provider]));
  assert.deepEqual(byProvider.get("anthropic"), {
    provider: "anthropic",
    name: "Anthropic",
    auth: { configured: true, source: "environment", environmentVariables: [] },
    managed: true,
    canSetApiKey: true,
    supportsOAuth: false,
    orphan: false,
    memo: null,
    keyUpdatedAt: null,
  });
  assert.equal(byProvider.get("openai")?.managed, false);
  assert.equal(byProvider.get("openai")?.canSetApiKey, false);
  assert.equal(byProvider.get("openai")?.supportsOAuth, true);
  assert.deepEqual(byProvider.get("legacy-orphan"), {
    provider: "legacy-orphan",
    name: "legacy-orphan",
    auth: { configured: false, environmentVariables: [] },
    managed: true,
    canSetApiKey: false,
    supportsOAuth: false,
    orphan: true,
    // カタログに無い行は SDK へ適用できない = 未反映
    degraded: "apply",
    memo: null,
    // 移行前の行は日時不明
    keyUpdatedAt: null,
  });
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes(KEY_A) && !serialized.includes(KEY_B), "キー値は応答に載せない");
  assert.deepEqual(runtime.calls, [], "GET は SDK を呼ばない");
});

test("GET はランタイム無しでも DB 行を orphan として返す", () => {
  const db = fakeDb({ "legacy-orphan": KEY_B });
  const { service } = createService({ db: db.db, runtime: null });
  const response = service.settings();
  assert.equal(response.runtimeAvailable, false);
  assert.deepEqual(
    response.providers.map((provider) => [provider.provider, provider.orphan, provider.degraded]),
    [["legacy-orphan", true, "apply"]],
  );
});

test("PUT は DB を先に確定し、SDK が成功すれば applied になる", async () => {
  const db = fakeDb();
  const log: string[] = [];
  const runtime = fakeRuntime({
    apply: (provider, apiKey) => {
      log.push(`apply:${provider}:${apiKey}`);
      return { outcome: "applied", synced: true };
    },
  });
  const { service, refreshCount } = createService({ db: db.db, runtime: runtime.runtime, log });

  const response = okBody(await service.putKey("anthropic", KEY_A));
  assert.equal(response.state, "applied");
  assert.equal(db.store.get("anthropic"), KEY_A, "DB が希望状態として先に確定する");
  assert.deepEqual(
    runtime.calls.map((call) => call.operation),
    ["apply"],
  );
  assert.deepEqual(log, [`retain:${KEY_A}`, `apply:anthropic:${KEY_A}`], "マスカー登録は SDK より前");
  assert.equal(refreshCount(), 1, "state の再計算は 1 回だけ");
  assert.equal(response.providers.find((provider) => provider.provider === "anthropic")?.degraded, undefined);
});

test("キーの最終保存日時は PUT で更新し、resync / 削除では書き換えない", async () => {
  const before = Date.now();
  const db = fakeDb({ legacy: KEY_B });
  const runtime = fakeRuntime({ providers: [{ provider: "anthropic" }, { provider: "legacy" }] });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  // 移行前の既存行は日時不明 (null) のまま
  assert.equal(service.settings().providers.find((provider) => provider.provider === "legacy")?.keyUpdatedAt, null);

  const put = okBody(await service.putKey("anthropic", KEY_A));
  const saved = put.providers.find((provider) => provider.provider === "anthropic")?.keyUpdatedAt;
  assert.equal(typeof saved, "number", "PUT の応答に保存時刻 (epoch ms) を載せる");
  assert.ok((saved ?? 0) >= before && (saved ?? 0) <= Date.now());
  assert.equal(
    service.settings().providers.find((provider) => provider.provider === "anthropic")?.keyUpdatedAt,
    saved,
    "GET も同じ保存日時を返す",
  );

  // 再同期は DB 行を書き換えないので日時は変わらない
  const resynced = okBody(await service.resync("anthropic"));
  assert.equal(resynced.providers.find((provider) => provider.provider === "anthropic")?.keyUpdatedAt, saved);

  // 削除は行ごと消えるため、以後は保存日時なし (managed: false)
  const deleted = okBody(await service.deleteKey("anthropic"));
  const gone = deleted.providers.find((provider) => provider.provider === "anthropic");
  assert.equal(gone?.managed, false);
  assert.equal(gone?.keyUpdatedAt, null);
});

test("PUT の DB 保存失敗は not_stored で SDK を呼ばない", async () => {
  const db = fakeDb();
  db.state.failSave = true;
  const runtime = fakeRuntime();
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const outcome = await service.putKey("anthropic", KEY_A);
  assert.equal(errorOf(outcome), "APIキーをアプリデータ（SQLite）へ保存できませんでした");
  assert.deepEqual(runtime.calls, []);
  assert.equal(db.store.has("anthropic"), false);
});

test("PUT は applied/synced でなければ同じ操作を 1 回だけ再試行する", async () => {
  let attempts = 0;
  const runtime = fakeRuntime({
    apply: () => {
      attempts += 1;
      return attempts === 1 ? { outcome: "unknown" } : { outcome: "applied", synced: true };
    },
  });
  const { service } = createService({ db: fakeDb().db, runtime: runtime.runtime });
  const response = okBody(await service.putKey("anthropic", KEY_A));
  assert.equal(response.state, "applied");
  assert.equal(attempts, 2, "再試行は 1 回だけ");

  const failing = fakeRuntime({ apply: () => ({ outcome: "applied", synced: false }) });
  const { service: failingService } = createService({ db: fakeDb().db, runtime: failing.runtime });
  const failed = okBody(await failingService.putKey("anthropic", KEY_A));
  assert.equal(failed.state, "applied_unsynced");
  assert.equal(failing.calls.length, 2, "失敗時の再試行も 1 回だけ");
  assert.equal(failed.providers.find((provider) => provider.provider === "anthropic")?.degraded, "apply");
});

test("PUT 成功で過去の degraded を解除する", async () => {
  const db = fakeDb();
  // 再試行も含めて失敗させないと degraded が付かない (失敗は 1 回目だけでは再試行で解消する)
  let failures = 2;
  const runtime = fakeRuntime({
    apply: () => {
      if (failures > 0) {
        failures -= 1;
        return { outcome: "unknown" };
      }
      return { outcome: "applied", synced: true };
    },
  });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  assert.equal(okBody(await service.putKey("anthropic", KEY_A)).state, "applied_unsynced");
  assert.equal(service.settings().providers[0]?.degraded, "apply");
  assert.equal(okBody(await service.putKey("anthropic", KEY_A)).state, "applied");
  assert.equal(service.settings().providers[0]?.degraded, undefined);
});

test("ランタイム無しの変更系は 503 not_stored で DB を書かない", async () => {
  const db = fakeDb();
  const { service } = createService({ db: db.db, runtime: null });
  for (const outcome of [
    await service.putKey("anthropic", KEY_A),
    await service.deleteKey("anthropic"),
    await service.resync("anthropic"),
  ]) {
    assert.equal(errorOf(outcome), PROVIDER_KEY_RUNTIME_UNAVAILABLE_MESSAGE);
  }
  assert.equal(db.store.size, 0);
});

test("PUT は未知の provider とキー登録を受け付けない provider を 400 で拒否する", async () => {
  const runtime = fakeRuntime({ providers: [{ provider: "anthropic", canSetApiKey: false }] });
  const db = fakeDb();
  const { service } = createService({ db: db.db, runtime: runtime.runtime });
  await assert.rejects(
    () => service.putKey("openai", KEY_A),
    (error: unknown) => {
      return (error as { statusCode?: number }).statusCode === 400;
    },
  );
  await assert.rejects(
    () => service.putKey("anthropic", KEY_A),
    (error: unknown) => {
      return (error as { statusCode?: number }).statusCode === 400;
    },
  );
  assert.deepEqual(runtime.calls, []);
  assert.equal(db.store.size, 0);
});

test("DB 書き込み後に DTO を組めなくても not_stored ではなく applied_unsynced を返す", async () => {
  const db = fakeDb();
  db.state.armListFailureOnSave = true;
  const runtime = fakeRuntime();
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const response = okBody(await service.putKey("anthropic", KEY_A));
  assert.equal(response.state, "applied_unsynced");
  assert.equal(response.providers.find((provider) => provider.provider === "anthropic")?.managed, true);
  assert.equal(response.providers.find((provider) => provider.provider === "anthropic")?.degraded, "apply");
  assert.equal(db.store.get("anthropic"), KEY_A);
});

test("DELETE 直後に一覧を読めなくても、削除した provider を保存済みとして返さない", async () => {
  const db = fakeDb({ anthropic: KEY_A });
  db.state.armListFailureOnDelete = true;
  const runtime = fakeRuntime({ remove: () => ({ outcome: "unknown" }) });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const response = okBody(await service.deleteKey("anthropic"));
  assert.equal(response.state, "applied_unsynced");
  const entry = response.providers.find((provider) => provider.provider === "anthropic");
  // managed は「DB に行がある」の契約。削除が確定した行を保存済みで返すと [削除] が残り、再削除が 400 になる
  assert.equal(entry?.managed, false);
  assert.equal(entry?.orphan, false);
  // 消えているのは DB 行だけ。runtime の overlay は残っているので再同期の導線は出る
  assert.equal(entry?.degraded, "remove");
  assert.equal(db.store.has("anthropic"), false);

  // 一覧が読めるようになれば、削除済みであることをそのまま報告する
  db.state.failList = false;
  assert.equal(service.settings().providers.find((provider) => provider.provider === "anthropic")?.managed, false);
});

test("DB 失敗の応答とログにキー値が現れない", async () => {
  const masker = createSecretMasker([KEY_A], { minLength: PROVIDER_API_KEY_MIN_LENGTH });
  const db = fakeDb();
  db.state.error = new Error(`sqlite failure with ${KEY_A}`);
  db.state.failSave = true;
  const runtime = fakeRuntime();
  const { service } = createService({ db: db.db, runtime: runtime.runtime, masker: (text) => masker.mask(text) });

  const { value, logs } = await captureConsole(() => service.putKey("anthropic", KEY_A));
  assert.equal(value.status, 503);
  assert.ok(!JSON.stringify(value).includes(KEY_A));
  assert.ok(!logs.join("\n").includes(KEY_A), `ログにもキーを出さない: ${logs.join("\n")}`);
  // ログは provider と操作の分類だけに絞る (DB の理由は AppDb の境界がマスクして記録する)
  assert.ok(logs.join("\n").includes("provider key save failed: anthropic"));
  assert.ok(!logs.join("\n").includes("sqlite failure"), "DB の生文言は境界の外へ出さない");
});

test("DELETE は行を消して removeApiKey を呼ぶ", async () => {
  const db = fakeDb({ anthropic: KEY_A });
  const runtime = fakeRuntime();
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const response = okBody(await service.deleteKey("anthropic"));
  assert.equal(response.state, "applied");
  assert.equal(db.store.has("anthropic"), false);
  assert.deepEqual(
    runtime.calls.map((call) => call.operation),
    ["remove"],
  );
  assert.equal(response.providers.find((provider) => provider.provider === "anthropic")?.managed, false);
});

test("DELETE は overlay が残る失敗で applied_unsynced + degraded remove を返す", async () => {
  const db = fakeDb({ anthropic: KEY_A });
  const runtime = fakeRuntime({ remove: () => ({ outcome: "unknown" }) });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const response = okBody(await service.deleteKey("anthropic"));
  assert.equal(response.state, "applied_unsynced");
  assert.equal(response.providers.find((provider) => provider.provider === "anthropic")?.degraded, "remove");
  assert.equal(runtime.calls.length, 2, "失敗時の再試行は 1 回だけ");
});

test("DELETE は行が無ければ 400 で SDK を呼ばない", async () => {
  const runtime = fakeRuntime();
  const { service } = createService({ db: fakeDb().db, runtime: runtime.runtime });
  await assert.rejects(
    () => service.deleteKey("anthropic"),
    (error: unknown) => (error as { message?: string }).message === PROVIDER_KEY_NOT_MANAGED_MESSAGE,
  );
  assert.deepEqual(runtime.calls, []);
});

test("DELETE はカタログに無い DB 行 (orphan) でも消せる", async () => {
  const db = fakeDb({ "legacy-orphan": KEY_B });
  const runtime = fakeRuntime();
  const { service } = createService({ db: db.db, runtime: runtime.runtime });
  assert.equal(okBody(await service.deleteKey("legacy-orphan")).state, "applied");
  assert.equal(db.store.size, 0);
});

test("DELETE は DB の読み書き失敗で SDK を呼ばない", async () => {
  const runtime = fakeRuntime();
  const readFailure = fakeDb({ anthropic: KEY_A });
  readFailure.state.failGet = true;
  const { service: readService } = createService({ db: readFailure.db, runtime: runtime.runtime });
  assert.equal((await readService.deleteKey("anthropic")).status, 503);

  const deleteFailure = fakeDb({ anthropic: KEY_A });
  deleteFailure.state.failDelete = true;
  const { service: deleteService } = createService({ db: deleteFailure.db, runtime: runtime.runtime });
  assert.equal((await deleteService.deleteKey("anthropic")).status, 503);
  assert.deepEqual(runtime.calls, []);
});

test("resync は degraded apply を再適用して解消する", async () => {
  const db = fakeDb();
  // 再試行も含めて失敗させて degraded を作る
  let failures = 2;
  const runtime = fakeRuntime({
    apply: () => {
      if (failures > 0) {
        failures -= 1;
        return { outcome: "unknown" };
      }
      return { outcome: "applied", synced: true };
    },
  });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });
  assert.equal(okBody(await service.putKey("anthropic", KEY_A)).state, "applied_unsynced");
  assert.equal(service.settings().providers[0]?.degraded, "apply");

  const response = okBody(await service.resync("anthropic"));
  assert.equal(response.state, "applied");
  assert.deepEqual(
    runtime.calls.map((call) => [call.operation, call.apiKey]),
    [
      ["apply", KEY_A],
      ["apply", KEY_A],
      ["apply", KEY_A],
    ],
    "resync は DB の希望値をそのまま再適用する",
  );
  assert.equal(response.providers[0]?.degraded, undefined);
});

test("resync は degraded remove の provider がカタログから消えても removeApiKey を呼ぶ", async () => {
  const db = fakeDb({ anthropic: KEY_A });
  // 削除の 1 回目・再試行だけ失敗させ、resync では成功させる
  let failures = 2;
  const runtime = fakeRuntime({
    remove: () => {
      if (failures > 0) {
        failures -= 1;
        return { outcome: "unknown" };
      }
      return { outcome: "applied", synced: true };
    },
  });
  const providers = runtime.providers;
  const { service } = createService({ db: db.db, runtime: runtime.runtime });
  assert.equal(okBody(await service.deleteKey("anthropic")).state, "applied_unsynced");

  providers.length = 0; // カタログからも消えた状態でも、degraded remove なら回復できる
  const response = okBody(await service.resync("anthropic"));
  assert.equal(response.state, "applied");
  assert.deepEqual(
    runtime.calls.map((call) => call.operation),
    ["remove", "remove", "remove"],
  );
  // カタログにも DB にも degraded にも残らないので、一覧からも消える
  assert.deepEqual(response.providers, []);
});

test("resync はカタログにも degraded にも無い provider を 400 で拒否する", async () => {
  const runtime = fakeRuntime();
  const { service } = createService({ db: fakeDb().db, runtime: runtime.runtime });
  await assert.rejects(
    () => service.resync("openai"),
    (error: unknown) => (error as { message?: string }).message === PROVIDER_RESYNC_TARGET_MESSAGE,
  );
  assert.deepEqual(runtime.calls, []);
});

test("resync は degraded でない provider にも DB の希望値を再適用する", async () => {
  const runtime = fakeRuntime();
  const { service } = createService({ db: fakeDb({ anthropic: KEY_A }).db, runtime: runtime.runtime });
  const response = okBody(await service.resync("anthropic"));
  assert.equal(response.state, "applied");
  assert.deepEqual(
    runtime.calls.map((call) => [call.operation, call.apiKey]),
    [["apply", KEY_A]],
  );
});

test("別 provider の並行 PUT は直列化され、両方の変更が公開 state に載る", async () => {
  const db = fakeDb();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const runtime = fakeRuntime({
    providers: [{ provider: "anthropic" }, { provider: "openai" }],
    apply: async (provider) => {
      events.push(`start:${provider}`);
      if (provider === "anthropic") await firstGate;
      events.push(`end:${provider}`);
      return { outcome: "applied", synced: true };
    },
  });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const first = service.putKey("anthropic", KEY_A);
  const second = service.putKey("openai", KEY_B);
  await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  assert.deepEqual(events, ["start:anthropic"], "2 件目は 1 件目の完了まで開始しない");
  releaseFirst?.();

  const [firstResponse, secondResponse] = [okBody(await first), okBody(await second)];
  assert.deepEqual(events, ["start:anthropic", "end:anthropic", "start:openai", "end:openai"]);
  const providers = secondResponse.providers
    .filter((provider) => provider.provider === "anthropic" || provider.provider === "openai")
    .map((provider) => [provider.provider, provider.managed]);
  assert.deepEqual(providers, [
    ["anthropic", true],
    ["openai", true],
  ]);
  assert.equal(firstResponse.state, "applied");
  assert.deepEqual([...db.store.keys()].sort(), ["anthropic", "openai"]);
});

test("1 回の例外で後続の変更が永久に止まらない", async () => {
  const db = fakeDb();
  let shouldThrow = true;
  const runtime = fakeRuntime({
    providers: [{ provider: "anthropic" }, { provider: "openai" }],
    apply: () => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("unexpected sdk failure");
      }
      return { outcome: "applied", synced: true };
    },
  });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  await assert.rejects(() => service.putKey("anthropic", KEY_A));
  const response = okBody(await service.putKey("openai", KEY_B));
  assert.equal(response.state, "applied");
  assert.equal(db.store.get("openai"), KEY_B);
});

test("起動適用は全キーを SDK より前にマスカーへ登録する", async () => {
  const db = fakeDb({ anthropic: KEY_A, openai: KEY_B });
  const log: string[] = [];
  const runtime = fakeRuntime({
    providers: [{ provider: "anthropic" }, { provider: "openai" }],
    apply: (provider, apiKey) => {
      log.push(`apply:${provider}:${apiKey}`);
      return { outcome: "applied", synced: true };
    },
  });
  const { service } = createService({ db: db.db, runtime: runtime.runtime, log });

  await service.applyStored();
  assert.deepEqual(log, [`retain:${KEY_A}`, `retain:${KEY_B}`, `apply:anthropic:${KEY_A}`, `apply:openai:${KEY_B}`]);
  assert.equal(
    service.settings().providers.some((provider) => provider.degraded),
    false,
  );
});

test("起動適用は orphan と短すぎる行を SDK へ渡さず degraded apply にする", async () => {
  const short = "abc";
  const db = fakeDb({ anthropic: KEY_A, "legacy-orphan": KEY_B, "keyless-local": short });
  const runtime = fakeRuntime();
  const { service, retained } = createService({ db: db.db, runtime: runtime.runtime });

  await service.applyStored();
  assert.deepEqual(
    runtime.calls.map((call) => call.provider),
    ["anthropic"],
    "カタログに無い行・短すぎる行は適用しない",
  );
  assert.deepEqual(retained, [KEY_A, KEY_B, short], "適用しない値も保護対象にする");
  const byProvider = new Map(service.settings().providers.map((provider) => [provider.provider, provider]));
  assert.equal(byProvider.get("legacy-orphan")?.degraded, "apply");
  assert.equal(byProvider.get("keyless-local")?.degraded, "apply");
});

test("起動適用の失敗は値も cause もログに出さない", async () => {
  const masker = createSecretMasker([KEY_A], { minLength: PROVIDER_API_KEY_MIN_LENGTH });
  const db = fakeDb({ anthropic: KEY_A });
  const runtime = fakeRuntime({ apply: () => ({ outcome: "unknown" }) });
  const { service } = createService({ db: db.db, runtime: runtime.runtime, masker: (text) => masker.mask(text) });

  const { logs } = await captureConsole(() => service.applyStored());
  const joined = logs.join("\n");
  assert.ok(joined.includes("anthropic") && joined.includes("unknown"), "provider id と分類は残す");
  assert.ok(!joined.includes(KEY_A), "キー値は出さない");
  assert.equal(service.settings().providers[0]?.degraded, "apply");
});

test("起動適用は DB を読めないとき空 DB として続行しない", async () => {
  const db = fakeDb({ anthropic: KEY_A });
  db.state.failList = true;
  const runtime = fakeRuntime();
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const { logs } = await captureConsole(() => service.applyStored());
  assert.deepEqual(runtime.calls, []);
  assert.ok(logs.join("\n").includes("provider credentials unavailable"));
  // 適用しなかったわけではないので、GET はそのまま DB の失敗を 503 として返す
  assert.throws(
    () => service.settings(),
    (error: unknown) => (error as { message?: string }).message === "sqlite failure",
  );
});

test("refreshModelState が例外を出しても変更系は応答を返す", async () => {
  const runtime = fakeRuntime();
  const { service } = createService({
    db: fakeDb().db,
    runtime: runtime.runtime,
    refresh: async () => {
      throw new Error("refresh failed");
    },
  });
  const { value, logs } = await captureConsole(() => service.putKey("anthropic", KEY_A));
  assert.equal(okBody(value).state, "applied");
  assert.ok(logs.join("\n").includes("model state refresh failed"));
});

// --- provider メモ (provider_memos) ---

test("GET は provider のメモを載せ、行が無ければ null になる", () => {
  const db = fakeDb({ anthropic: KEY_A });
  db.memos.set("anthropic", "個人アカウントの本番キー");
  const runtime = fakeRuntime({ providers: [{ provider: "anthropic" }, { provider: "openai" }] });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const byProvider = new Map(service.settings().providers.map((provider) => [provider.provider, provider]));
  assert.equal(byProvider.get("anthropic")?.memo, "個人アカウントの本番キー");
  assert.equal(byProvider.get("openai")?.memo, null);
});

test("メモだけの provider を GET の 4 経路目として出し、degraded を付けない", () => {
  const db = fakeDb();
  db.memos.set("memo-only", "無料枠の控え");
  const runtime = fakeRuntime({ providers: [{ provider: "anthropic" }] });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const entry = service.settings().providers.find((provider) => provider.provider === "memo-only");
  assert.deepEqual(entry, {
    provider: "memo-only",
    name: "memo-only",
    auth: { configured: false, environmentVariables: [] },
    managed: false,
    canSetApiKey: false,
    supportsOAuth: false,
    orphan: true,
    memo: "無料枠の控え",
    keyUpdatedAt: null,
  });
});

test("メモは trim して保存し、SDK を呼ばず degraded も作らない", async () => {
  const db = fakeDb();
  const runtime = fakeRuntime();
  const { service, refreshCount } = createService({ db: db.db, runtime: runtime.runtime });

  const response = okBody(await service.putMemo("anthropic", "  個人アカウント  "));
  assert.equal(response.state, "applied");
  assert.equal(db.memos.get("anthropic"), "個人アカウント");
  const entry = response.providers.find((provider) => provider.provider === "anthropic");
  assert.equal(entry?.memo, "個人アカウント");
  assert.equal(entry?.managed, false, "メモの保存でキーの行を作らない");
  assert.equal(entry?.degraded, undefined);
  assert.equal(refreshCount(), 0, "SDK / 公開 state に触れない");
  assert.deepEqual(runtime.calls, []);
});

test("メモは空にして保存すると行を消して 200 applied を返す", async () => {
  const db = fakeDb({ anthropic: KEY_A });
  db.memos.set("anthropic", "古いメモ");
  const runtime = fakeRuntime();
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const response = okBody(await service.putMemo("anthropic", "   "));
  assert.equal(response.state, "applied");
  assert.equal(db.memos.has("anthropic"), false);
  assert.equal(response.providers.find((provider) => provider.provider === "anthropic")?.memo, null);
});

test("カタログ外でも credential 行かメモ行があればメモを保存できる", async () => {
  const runtime = fakeRuntime();
  const withCredential = fakeDb({ "legacy-orphan": KEY_B });
  const { service: credentialService } = createService({ db: withCredential.db, runtime: runtime.runtime });
  const credentialResponse = okBody(await credentialService.putMemo("legacy-orphan", "旧 provider の控え"));
  const credentialEntry = credentialResponse.providers.find((provider) => provider.provider === "legacy-orphan");
  assert.equal(credentialEntry?.memo, "旧 provider の控え");
  assert.equal(credentialEntry?.managed, true, "キーの行の意味はメモで変えない");
  assert.equal(credentialEntry?.degraded, "apply");

  const withMemo = fakeDb();
  withMemo.memos.set("memo-only", "既存のメモ");
  const { service: memoService } = createService({ db: withMemo.db, runtime: runtime.runtime });
  const memoResponse = okBody(await memoService.putMemo("memo-only", "更新後"));
  assert.equal(memoResponse.providers.find((provider) => provider.provider === "memo-only")?.memo, "更新後");
});

test("メモの保存は対象外 provider を 400 で拒否し、canSetApiKey では gate しない", async () => {
  const runtime = fakeRuntime({ providers: [{ provider: "anthropic", canSetApiKey: false }] });
  const db = fakeDb();
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  await assert.rejects(
    () => service.putMemo("ghost", "メモ"),
    (error: unknown) =>
      (error as { statusCode?: number }).statusCode === 400 &&
      (error as { message?: string }).message === PROVIDER_MEMO_TARGET_MESSAGE,
  );
  assert.equal(db.memos.size, 0);
  // login を持たない provider でもメモは書ける (キーの登録可否と独立)
  assert.equal(okBody(await service.putMemo("anthropic", "メモ")).state, "applied");
});

test("ランタイム無しのメモ保存はメモ専用文言の 503 not_stored", async () => {
  const db = fakeDb();
  const { service } = createService({ db: db.db, runtime: null });
  const outcome = await service.putMemo("anthropic", "メモ");
  assert.equal(outcome.status, 503);
  assert.equal(outcome.status === 503 ? outcome.error : "", PROVIDER_MEMO_RUNTIME_UNAVAILABLE_MESSAGE);
  assert.notEqual(PROVIDER_MEMO_RUNTIME_UNAVAILABLE_MESSAGE, PROVIDER_KEY_RUNTIME_UNAVAILABLE_MESSAGE);
  assert.equal(db.memos.size, 0);
});

test("メモの DB 読取・書込失敗は 503 not_stored になる", async () => {
  const runtime = fakeRuntime();
  const readFailure = fakeDb();
  readFailure.state.failGetMemo = true;
  const { service: readService } = createService({ db: readFailure.db, runtime: runtime.runtime });
  const readOutcome = await readService.putMemo("ghost", "メモ");
  assert.equal(readOutcome.status === 503 ? readOutcome.error : "", PROVIDER_MEMO_NOT_STORED_MESSAGE);

  const saveFailure = fakeDb();
  saveFailure.state.failSaveMemo = true;
  const { service: saveService } = createService({ db: saveFailure.db, runtime: runtime.runtime });
  const saveOutcome = await saveService.putMemo("anthropic", "メモ");
  assert.equal(saveOutcome.status === 503 ? saveOutcome.error : "", PROVIDER_MEMO_NOT_STORED_MESSAGE);

  const deleteFailure = fakeDb();
  deleteFailure.memos.set("anthropic", "古いメモ");
  deleteFailure.state.failDeleteMemo = true;
  const { service: deleteService } = createService({ db: deleteFailure.db, runtime: runtime.runtime });
  assert.equal((await deleteService.putMemo("anthropic", "")).status, 503);
});

test("メモの DB 失敗の応答とログにメモ値が現れない", async () => {
  const memo = "個人アカウントの控え";
  const db = fakeDb();
  db.state.error = new Error(`sqlite failure with ${memo}`);
  db.state.failSaveMemo = true;
  const runtime = fakeRuntime();
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const { value, logs } = await captureConsole(() => service.putMemo("anthropic", memo));
  assert.equal(value.status, 503);
  assert.ok(!JSON.stringify(value).includes(memo));
  assert.ok(!logs.join("\n").includes(memo), `ログにもメモを出さない: ${logs.join("\n")}`);
  // ログは provider と操作の分類だけに絞る (DB の理由は AppDb の境界が記録する)
  assert.ok(logs.join("\n").includes("provider memo save failed: anthropic"));
});

test("メモの保存後にメモ一覧を読めなくても applied を返す", async () => {
  const db = fakeDb();
  db.state.armListFailureOnSaveMemo = true;
  const runtime = fakeRuntime();
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const { value } = await captureConsole(() => service.putMemo("anthropic", "メモ"));
  const response = okBody(value);
  assert.equal(response.state, "applied", "DB への保存は確定している");
  assert.equal(db.memos.get("anthropic"), "メモ");
  assert.equal(
    response.providers.find((provider) => provider.provider === "anthropic")?.managed,
    false,
    "読めない側は空で組む (キーの行を復元しない)",
  );
});

test("キーを削除してもメモは残す", async () => {
  const db = fakeDb({ anthropic: KEY_A });
  db.memos.set("anthropic", "個人アカウントの控え");
  const runtime = fakeRuntime();
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const response = okBody(await service.deleteKey("anthropic"));
  assert.equal(db.memos.get("anthropic"), "個人アカウントの控え", "キー削除はメモに触らない");
  const entry = response.providers.find((provider) => provider.provider === "anthropic");
  assert.equal(entry?.memo, "個人アカウントの控え");
  assert.equal(entry?.managed, false);
  assert.equal(entry?.degraded, undefined, "キーが無いのに未反映にならない");
});

// --- 利用可能なモデル / アプリ既定モデル (model_settings) ---

const CATALOG: ModelRef[] = [
  { provider: "anthropic", id: "claude-sonnet-4-5" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "openai", id: "gpt-5.6-luna" },
];
/** API の許可リストは "provider/model" の文字列 (DB 行は ModelRef の JSON 配列) */
const CATALOG_LABELS = CATALOG.map((model) => `${model.provider}/${model.id}`);

test("GET は保存値を返し、無視している環境変数名を載せる", () => {
  const db = fakeDb(
    {},
    { allowedModels: [{ provider: "anthropic", id: "claude-haiku-4-5" }], defaultModel: "anthropic/claude-haiku-4-5" },
  );
  const runtime = fakeRuntime({ catalog: CATALOG });
  const { service } = createService({
    db: db.db,
    runtime: runtime.runtime,
    ignoredEnvironmentVariables: ["PI_MODELS", "PI_PROVIDER"],
  });

  const response = service.settings();
  assert.deepEqual(response.allowedModels, ["anthropic/claude-haiku-4-5"]);
  assert.equal(response.defaultModel, "anthropic/claude-haiku-4-5");
  assert.deepEqual(response.ignoredEnvironmentVariables, ["PI_MODELS", "PI_PROVIDER"]);
  assert.deepEqual(runtime.calls, [], "GET は SDK を呼ばない");
});

test("PUT は重複を正規化し、setter → refresh を 1 回ずつ通す", async () => {
  const db = fakeDb();
  const runtime = fakeRuntime({ catalog: CATALOG });
  const { service, refreshCount, selections, events } = createService({ db: db.db, runtime: runtime.runtime });

  const response = okBody(
    await service.putModelSelection({
      allowedModels: ["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"],
      defaultModel: "anthropic/claude-haiku-4-5",
    }),
  );
  assert.equal(response.state, "applied");
  assert.deepEqual(response.allowedModels, ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"]);
  assert.equal(response.defaultModel, "anthropic/claude-haiku-4-5");
  assert.deepEqual(db.readSelection(), {
    allowedModels: [
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
    ],
    defaultModel: "anthropic/claude-haiku-4-5",
  });
  assert.deepEqual(selections, [
    {
      allowedModels: [
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "anthropic", id: "claude-haiku-4-5" },
      ],
      defaultModel: { provider: "anthropic", id: "claude-haiku-4-5" },
    },
  ]);
  assert.deepEqual(events, ["set", "refresh"], "公開 state へ効かせるのは refresh で、setter が先");
  assert.equal(refreshCount(), 1, "再計算は 1 回だけ");
});

test("PUT は空配列と両方 null を未設定へ正規化する", async () => {
  const db = fakeDb({}, { allowedModels: CATALOG, defaultModel: "anthropic/claude-sonnet-4-5" });
  const runtime = fakeRuntime({ catalog: CATALOG });
  const { service, selections } = createService({ db: db.db, runtime: runtime.runtime });

  const cleared = okBody(await service.putModelSelection({ allowedModels: null, defaultModel: null }));
  assert.equal(cleared.allowedModels, null);
  assert.equal(cleared.defaultModel, null);
  assert.equal(db.readSelection(), undefined, "行を消して未設定へ戻す");
  assert.deepEqual(selections.at(-1), { allowedModels: undefined, defaultModel: undefined });

  // 空配列の保存も「制限なし」の 1 行として扱う (明示空と未設定を区別しない)
  const empty = okBody(
    await service.putModelSelection({ allowedModels: [], defaultModel: "anthropic/claude-haiku-4-5" }),
  );
  assert.equal(empty.allowedModels, null);
  assert.equal(db.readSelection()?.allowedModels, null);
});

test("PUT はカタログ外・既定が許可外・形式不正を 400 で拒否し、DB と setter を触らない", async () => {
  const db = fakeDb();
  const runtime = fakeRuntime({ catalog: CATALOG });
  const { service, selections, refreshCount } = createService({ db: db.db, runtime: runtime.runtime });

  const statusOf = (error: unknown) => (error as { statusCode?: number }).statusCode;
  const messageOf = (error: unknown) => (error as { message?: string }).message;

  await assert.rejects(
    () => service.putModelSelection({ allowedModels: ["anthropic/ghost"], defaultModel: null }),
    (error: unknown) =>
      statusOf(error) === 400 && messageOf(error) === `${MODEL_SELECTION_NOT_IN_CATALOG_MESSAGE}: anthropic/ghost`,
  );
  // 未認証でもカタログにあるモデルは許可できる (認証済みかどうかは保存の条件ではない)
  await assert.rejects(
    () =>
      service.putModelSelection({
        allowedModels: ["openai/gpt-5.6-luna"],
        defaultModel: "anthropic/claude-haiku-4-5",
      }),
    (error: unknown) =>
      statusOf(error) === 400 &&
      messageOf(error) === `${MODEL_SELECTION_DEFAULT_NOT_ALLOWED_MESSAGE}: anthropic/claude-haiku-4-5`,
  );
  await assert.rejects(
    () => service.putModelSelection({ allowedModels: null, defaultModel: "claude-sonnet-4-5" }),
    (error: unknown) => statusOf(error) === 400 && messageOf(error) === MODEL_SELECTION_FORMAT_MESSAGE,
  );
  await assert.rejects(
    () => service.putModelSelection({ allowedModels: null, defaultModel: "anthropic/ghost" }),
    (error: unknown) =>
      statusOf(error) === 400 && messageOf(error) === `${MODEL_SELECTION_NOT_IN_CATALOG_MESSAGE}: anthropic/ghost`,
  );

  assert.equal(db.readSelection(), undefined);
  assert.deepEqual(selections, []);
  assert.equal(refreshCount(), 0);
});

test("PUT は制限なしのときカタログ全体から既定を選べる", async () => {
  const db = fakeDb();
  const runtime = fakeRuntime({ catalog: CATALOG });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });
  const response = okBody(
    await service.putModelSelection({ allowedModels: null, defaultModel: "openai/gpt-5.6-luna" }),
  );
  assert.equal(response.state, "applied");
  assert.equal(response.defaultModel, "openai/gpt-5.6-luna");
  assert.equal(response.allowedModels, null);
});

test("PUT の DB 保存失敗は 503 not_stored で setter / refresh を呼ばない", async () => {
  const db = fakeDb();
  db.state.failSaveSelection = true;
  const runtime = fakeRuntime({ catalog: CATALOG });
  const { service, selections, refreshCount } = createService({ db: db.db, runtime: runtime.runtime });

  const { value, logs } = await captureConsole(() =>
    service.putModelSelection({ allowedModels: CATALOG_LABELS, defaultModel: null }),
  );
  assert.equal(value.status, 503);
  assert.equal(value.status === 503 ? value.error : "", MODEL_SELECTION_NOT_STORED_MESSAGE);
  assert.equal(db.readSelection(), undefined);
  assert.deepEqual(selections, []);
  assert.equal(refreshCount(), 0);
  assert.ok(logs.join("\n").includes("model selection save failed"));
});

test("PUT は保存後に一覧を読めなくても applied を返す", async () => {
  const db = fakeDb();
  db.state.armListFailureOnSave = true;
  const runtime = fakeRuntime({ catalog: CATALOG });
  const { service } = createService({ db: db.db, runtime: runtime.runtime });

  const response = okBody(
    await service.putModelSelection({ allowedModels: null, defaultModel: "anthropic/claude-haiku-4-5" }),
  );
  assert.equal(response.state, "applied", "DB への保存は確定している");
  assert.equal(response.defaultModel, "anthropic/claude-haiku-4-5");
  assert.equal(
    response.providers.some((provider) => provider.managed),
    false,
    "一覧を読めない側は空で組む (キーの行は復元しない)",
  );
});

test("ランタイム無しの PUT は 503 not_stored で DB を書かない", async () => {
  const db = fakeDb();
  const { service } = createService({ db: db.db, runtime: null });
  const outcome = await service.putModelSelection({ allowedModels: CATALOG_LABELS, defaultModel: null });
  assert.equal(outcome.status, 503);
  assert.equal(outcome.status === 503 ? outcome.error : "", MODEL_SELECTION_RUNTIME_UNAVAILABLE_MESSAGE);
  assert.equal(db.readSelection(), undefined);
});

test("起動適用は保存値を setter → refresh の順で 1 回ずつ通す", async () => {
  const db = fakeDb({}, { allowedModels: CATALOG, defaultModel: "openai/gpt-5.6-luna" });
  const runtime = fakeRuntime({ catalog: CATALOG });
  const { service, selections, events, refreshCount } = createService({ db: db.db, runtime: runtime.runtime });

  await service.applyStored();
  assert.deepEqual(selections, [{ allowedModels: CATALOG, defaultModel: { provider: "openai", id: "gpt-5.6-luna" } }]);
  assert.deepEqual(events, ["set", "refresh"]);
  assert.equal(refreshCount(), 1);
});

test("起動適用は保存値の読取失敗でも警告だけ残して続行する (制限なし)", async () => {
  const db = fakeDb({ anthropic: KEY_A }, { allowedModels: CATALOG, defaultModel: null });
  db.state.failReadSelection = true;
  const runtime = fakeRuntime({ catalog: CATALOG });
  const { service, selections, refreshCount } = createService({ db: db.db, runtime: runtime.runtime });

  const { logs } = await captureConsole(() => service.applyStored());
  assert.ok(logs.join("\n").includes("model settings unavailable"), "起動ログに警告を残す");
  assert.deepEqual(selections, [], "読めなかった側は写さない (初期 state = 制限なしのまま)");
  assert.deepEqual(
    runtime.calls.map((call) => call.operation),
    ["apply"],
    "片方の読取失敗でも他方 (provider キー) の適用は続ける",
  );
  assert.equal(refreshCount(), 1, "最後の再計算は行う");
});

test("起動適用は provider キーの読取失敗でも保存値の適用と再計算を行う", async () => {
  const db = fakeDb({ anthropic: KEY_A }, { allowedModels: CATALOG, defaultModel: "anthropic/claude-haiku-4-5" });
  db.state.failList = true;
  const runtime = fakeRuntime({ catalog: CATALOG });
  const { service, selections, refreshCount } = createService({ db: db.db, runtime: runtime.runtime });

  const { logs } = await captureConsole(() => service.applyStored());
  assert.ok(logs.join("\n").includes("provider credentials unavailable"));
  assert.deepEqual(selections, [
    { allowedModels: CATALOG, defaultModel: { provider: "anthropic", id: "claude-haiku-4-5" } },
  ]);
  assert.deepEqual(runtime.calls, [], "読めなかった側の SDK 適用はしない");
  assert.equal(refreshCount(), 1);
});

test("起動適用は手で壊された既定モデルを未設定として続行する", async () => {
  const db = fakeDb({}, { allowedModels: null, defaultModel: "broken" });
  const runtime = fakeRuntime({ catalog: CATALOG });
  const { service, selections } = createService({ db: db.db, runtime: runtime.runtime });

  const { logs } = await captureConsole(() => service.applyStored());
  assert.deepEqual(selections, [{ allowedModels: undefined, defaultModel: undefined }]);
  assert.ok(logs.join("\n").includes("stored default model is invalid"));
});

// --- カタログの手動更新 (POST /api/settings/models/catalog/refresh) ---

function catalogBody(outcome: CatalogRefreshOutcome) {
  if (outcome.status !== 200) throw new Error(`expected 200, got ${outcome.status}: ${outcome.error}`);
  return outcome.response;
}

function catalogErrorOf(outcome: CatalogRefreshOutcome) {
  if (outcome.status !== 503) throw new Error(`expected 503, got ${outcome.status}`);
  return outcome.error;
}

test("カタログ更新は allowNetwork / force 付きで 1 回だけ試し、再計算後に読んだ一覧を返す", async () => {
  const after: RuntimeModelsResponse = { ...CATALOG_SNAPSHOT, catalogCount: 2, availableCount: 2 };
  const runtimeOptions: NonNullable<Parameters<typeof fakeRuntime>[0]> = {
    catalogSnapshot: CATALOG_SNAPSHOT,
    refreshCatalog: () => {
      // 実 SDK は取得できた provider を overlay へ写す。再計算後に読む値が変わることをここで再現する
      runtimeOptions.catalogSnapshot = after;
      return { aborted: false, failedProviders: 0 };
    },
  };
  const runtime = fakeRuntime(runtimeOptions);
  const { service, refreshCount } = createService({ db: fakeDb().db, runtime: runtime.runtime });

  const response = catalogBody(await service.refreshCatalog());
  assert.deepEqual(runtime.catalogRefreshCalls, [{ allowNetwork: true, force: true, aborted: false }]);
  assert.equal(refreshCount(), 1, "取得の後で公開 state を 1 回だけ再計算する");
  assert.equal(response.catalogError, null);
  assert.equal(response.catalogCount, 2, "応答は更新後の一覧");
  assert.deepEqual(response.providers, after.providers);
});

test("一部 provider の失敗は 200 と固定文言に寄せ、一覧は現在値のまま返す", async () => {
  const runtime = fakeRuntime({
    catalogSnapshot: CATALOG_SNAPSHOT,
    refreshCatalog: () => ({ aborted: false, failedProviders: 2 }),
  });
  const { service } = createService({ db: fakeDb().db, runtime: runtime.runtime });

  const { value: outcome, logs } = await captureConsole(() => service.refreshCatalog());
  const response = catalogBody(outcome);
  assert.equal(response.catalogError, MODEL_CATALOG_ERROR_PARTIAL);
  assert.deepEqual(response.providers, CATALOG_SNAPSHOT.providers, "取得できた範囲の一覧は残す");
  assert.ok(logs.join("\n").includes("model catalog refresh incomplete"), "ログには件数だけを残す");
  assert.ok(!logs.join("\n").includes("anthropic"), "provider の内訳はログへ出さない");
});

test("期限で abort した取得は一覧を保ち、provider の失敗と同時でもタイムアウトを優先する", async () => {
  const runtime = fakeRuntime({
    catalogSnapshot: CATALOG_SNAPSHOT,
    refreshCatalog: ({ signal }) =>
      new Promise((resolve) => {
        // 実 SDK は期限の signal で中断し、aborted と部分的な errors を同時に返し得る
        signal.addEventListener("abort", () => resolve({ aborted: true, failedProviders: 3 }), { once: true });
      }),
  });
  const { service } = createService({ db: fakeDb().db, runtime: runtime.runtime, catalogTimeoutMs: 5 });

  const response = catalogBody(await service.refreshCatalog());
  assert.equal(response.catalogError, MODEL_CATALOG_ERROR_TIMEOUT);
  assert.deepEqual(response.providers, CATALOG_SNAPSHOT.providers);
  assert.equal(runtime.catalogRefreshCalls.length, 1);
  assert.equal(runtime.catalogRefreshCalls[0]?.aborted, false, "期限はサービスが作る (開始時には abort していない)");
});

test("refresh の例外は固定文言へ寄せ、生の文言を応答へ出さずログはマスカーを通す", async () => {
  const secret = "sk-live-RAW-0123456789";
  const raw = `ModelConfig.load failed: /root/.pi/agent/models.json ${secret}`;
  const runtime = fakeRuntime({
    catalogSnapshot: CATALOG_SNAPSHOT,
    refreshCatalog: () => {
      throw new Error(raw);
    },
  });
  const { service } = createService({
    db: fakeDb().db,
    runtime: runtime.runtime,
    masker: (text) => text.replaceAll(secret, "<masked>"),
  });

  const { value: outcome, logs } = await captureConsole(() => service.refreshCatalog());
  const response = catalogBody(outcome);
  assert.equal(response.catalogError, MODEL_CATALOG_ERROR_UNKNOWN);
  assert.ok(!JSON.stringify(response).includes("ModelConfig.load failed"), "生の例外文言を応答へ出さない");
  assert.ok(!JSON.stringify(response).includes(secret), "秘密も応答へ出さない");
  assert.ok(logs.join("\n").includes("<masked>"), "ログはマスカーを通す");
  assert.ok(!logs.join("\n").includes(secret), "マスク前の値をログにも残さない");
});

test("PI_OFFLINE では取得せず、現在の一覧と固定文言を返す", async () => {
  const runtime = fakeRuntime({ catalogSnapshot: CATALOG_SNAPSHOT });
  const { service } = createService({ db: fakeDb().db, runtime: runtime.runtime });
  const original = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    const response = catalogBody(await service.refreshCatalog());
    assert.equal(response.catalogError, MODEL_CATALOG_ERROR_OFFLINE);
    assert.deepEqual(runtime.catalogRefreshCalls, [], "SDK の refresh は呼ばない");
    assert.deepEqual(response.providers, CATALOG_SNAPSHOT.providers);
  } finally {
    if (original === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = original;
  }
});

test("カタログを返せないときは 503 (GET /api/runtime/models と同じ契約)", async () => {
  const runtime = fakeRuntime({ catalogSnapshot: null });
  const { service } = createService({ db: fakeDb().db, runtime: runtime.runtime });
  const outcome = await service.refreshCatalog();
  assert.equal(catalogErrorOf(outcome), RUNTIME_MODELS_UNAVAILABLE_MESSAGE);
  assert.equal(runtime.catalogRefreshCalls.length, 1, "取得は試みる (失敗を一覧の不在と言い換えない)");
});

test("ランタイム無しのカタログ更新は既存の設定 API と同じ 503", async () => {
  const { service } = createService({ db: fakeDb().db, runtime: null });
  const outcome = await service.refreshCatalog();
  assert.equal(catalogErrorOf(outcome), RUNTIME_MODELS_UNAVAILABLE_MESSAGE);
});

test("カタログ更新はキー変更と同じロックを通り、後から来たキー変更を待たせる", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = fakeRuntime({
    catalogSnapshot: CATALOG_SNAPSHOT,
    refreshCatalog: async () => {
      order.push("catalog:start");
      await gate;
      order.push("catalog:end");
      return { aborted: false, failedProviders: 0 };
    },
    apply: () => {
      order.push("key:apply");
      return { outcome: "applied", synced: true };
    },
  });
  const { service } = createService({ db: fakeDb().db, runtime: runtime.runtime });

  const refresh = service.refreshCatalog();
  const deadline = Date.now() + 1000;
  while (!order.includes("catalog:start") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(order.includes("catalog:start"), "更新がロックを取り始める");
  const put = service.putKey("anthropic", KEY_A);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["catalog:start"], "更新の完了前にはキー変更が入らない");
  release();
  await refresh;
  await put;
  assert.deepEqual(order, ["catalog:start", "catalog:end", "key:apply"]);
});
