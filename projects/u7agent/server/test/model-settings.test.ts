// 設定 → モデル (プロバイダー API キー) のサービス契約。実 API は呼ばず、fake の ProviderKeyRuntime / DB で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { createSecretMasker } from "../src/redact";
import {
  ModelSettingsService,
  PROVIDER_KEY_NOT_MANAGED_MESSAGE,
  PROVIDER_KEY_RUNTIME_UNAVAILABLE_MESSAGE,
  PROVIDER_RESYNC_TARGET_MESSAGE,
  type CredentialCommit,
  type ModelSettingsDb,
  type MutationOutcome,
  type ProviderKeyRuntime,
} from "../src/model-settings";
import { PROVIDER_API_KEY_MIN_LENGTH } from "../src/schema";

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

/** SDK 面の fake。apply / remove の実装だけテストごとに差し替え、呼び出しを記録する */
function fakeRuntime(
  options: {
    providers?: FakeProvider[];
    apply?: (provider: string, apiKey: string, signal: AbortSignal) => CredentialCommit | Promise<CredentialCommit>;
    remove?: (provider: string, signal: AbortSignal) => CredentialCommit | Promise<CredentialCommit>;
  } = {},
) {
  const providers = options.providers ?? [{ provider: "anthropic", configured: true }];
  const configured = new Map(providers.map((entry) => [entry.provider, entry.configured ?? false]));
  const calls: RuntimeCall[] = [];
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
  return { runtime, providers, calls, configured };
}

/** DB 面の fake。失敗フラグで AppDb の失敗経路を再現する */
function fakeDb(rows: Record<string, string> = {}) {
  const store = new Map(Object.entries(rows));
  const state = {
    failList: false,
    failGet: false,
    failSave: false,
    failDelete: false,
    /** 保存は成功させるが、以後の一覧読みを失敗させる (DTO 組み立てだけが壊れる経路) */
    armListFailureOnSave: false,
    /** 削除は成功させるが、以後の一覧読みを失敗させる (DELETE だけが DTO を組めない経路) */
    armListFailureOnDelete: false,
    error: new Error("sqlite failure"),
  };
  const db: ModelSettingsDb = {
    listProviderCredentials: () => {
      if (state.failList) throw state.error;
      return [...store].map(([provider, apiKey]) => ({ provider, apiKey }));
    },
    getProviderCredential: (provider) => {
      if (state.failGet) throw state.error;
      const apiKey = store.get(provider);
      return apiKey === undefined ? undefined : { provider, apiKey };
    },
    saveProviderCredential: (provider, apiKey) => {
      if (state.failSave) throw state.error;
      store.set(provider, apiKey);
      if (state.armListFailureOnSave) state.failList = true;
    },
    deleteProviderCredential: (provider) => {
      if (state.failDelete) throw state.error;
      const deleted = store.delete(provider);
      if (state.armListFailureOnDelete) state.failList = true;
      return deleted;
    },
  };
  return { db, store, state };
}

function createService(options: {
  db: ModelSettingsDb;
  runtime: ProviderKeyRuntime | null;
  retained?: string[];
  log?: string[];
  refresh?: () => Promise<void>;
  masker?: (text: string) => string;
}) {
  const retained = options.retained ?? [];
  const refreshes: number[] = [];
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
      refreshes.push(1);
      await options.refresh?.();
    },
    defaultModel: () => "anthropic/claude-sonnet-4-5",
    whitelistConfigured: () => false,
  });
  return { service, retained, refreshCount: () => refreshes.length };
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
  assert.equal(response.defaultModel, "anthropic/claude-sonnet-4-5");
  const byProvider = new Map(response.providers.map((provider) => [provider.provider, provider]));
  assert.deepEqual(byProvider.get("anthropic"), {
    provider: "anthropic",
    name: "Anthropic",
    auth: { configured: true, source: "environment", environmentVariables: [] },
    managed: true,
    canSetApiKey: true,
    supportsOAuth: false,
    orphan: false,
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
