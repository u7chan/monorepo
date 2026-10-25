// カスタムプロバイダーの検証・メモリ上の Store・作成 / 更新 / 削除の契約。SDK は fake で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOM_PROVIDER_APPLY_FAILED_MESSAGE,
  CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
  CUSTOM_PROVIDER_ID_CONFLICT_MESSAGE,
  CUSTOM_PROVIDER_ID_MESSAGE,
  CUSTOM_PROVIDER_NOT_FOUND_MESSAGE,
  CUSTOM_PROVIDER_REMOVE_FAILED_MESSAGE,
  CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE,
  CustomProviderStore,
  customProviderRuntimeConfig,
  normalizeCustomProviderBaseUrl,
  parseCustomProviderInput,
  parseCustomProviderUpdate,
  type CustomProviderDefinition,
  type CustomProviderRuntimeConfig,
} from "../src/custom-providers";
import {
  MODEL_SELECTION_RUNTIME_UNAVAILABLE_MESSAGE,
  ModelSettingsService,
  type CredentialCommit,
  type ModelSettingsDb,
  type ProviderKeyRuntime,
} from "../src/model-settings";
import type { ModelRef } from "../src/schema";
import { createSecretMasker } from "../src/redact";

const KEY = "sk-custom-dummy-key-0123456789";

const applied: CredentialCommit = { outcome: "applied", synced: true };
const failed: CredentialCommit = { outcome: "not_applied" };

interface FakeProvider {
  provider: string;
  name?: string;
}

/** SDK 面の fake。登録の成否とキー適用の成否をテストごとに差し替え、呼び出し順を記録する */
function fakeRuntime(
  options: {
    providers?: FakeProvider[];
    catalog?: ModelRef[];
    apply?: (provider: string, apiKey: string) => CredentialCommit | Promise<CredentialCommit>;
    remove?: (provider: string) => CredentialCommit | Promise<CredentialCommit>;
    register?: (provider: string, config: CustomProviderRuntimeConfig) => void;
  } = {},
) {
  const builtins = options.providers ?? [{ provider: "anthropic", name: "Anthropic" }];
  const registered = new Map<string, CustomProviderRuntimeConfig>();
  const calls: string[] = [];
  const authReads: string[] = [];
  const service: ProviderKeyRuntime = {
    list: () => [
      ...builtins.map((entry) => ({
        provider: entry.provider,
        name: entry.name ?? entry.provider,
        canSetApiKey: true,
        supportsOAuth: false,
        canSignInHere: false,
        oauthLoginLabel: null,
      })),
      ...[...registered].map(([provider, config]) => ({
        provider,
        name: config.name,
        canSetApiKey: true,
        supportsOAuth: false,
        canSignInHere: false,
        oauthLoginLabel: null,
      })),
    ],
    auth: (provider) => {
      authReads.push(provider);
      return registered.has(provider) ? { configured: true, source: "runtime" } : { configured: false };
    },
    credentialKind: () => "api_key",
    // カスタム provider では auth.json を読まないことを固定するため、読んだ provider を記録する
    storedCredentialKind: (provider) => {
      calls.push(`storedCredentialKind:${provider}`);
      return undefined;
    },
    catalog: () => options.catalog ?? [],
    refreshCatalog: async () => ({ aborted: false, failedProviders: 0 }),
    catalogSnapshot: () => undefined,
    applyApiKey: async (provider, apiKey) => {
      calls.push(`apply:${provider}:${apiKey}`);
      return options.apply ? options.apply(provider, apiKey) : applied;
    },
    removeApiKey: async (provider) => {
      calls.push(`remove:${provider}`);
      return options.remove ? options.remove(provider) : applied;
    },
    registerProvider: (provider, config) => {
      calls.push(`register:${provider}`);
      options.register?.(provider, config);
      registered.set(provider, config);
    },
    unregisterProvider: (provider) => {
      calls.push(`unregister:${provider}`);
      registered.delete(provider);
    },
  };
  return { service, calls, registered, builtins };
}

function fakeDb(): ModelSettingsDb & { credentials: Map<string, string>; memos: Map<string, string> } {
  const credentials = new Map<string, string>();
  const memos = new Map<string, string>();
  return {
    credentials,
    memos,
    listProviderCredentials: () => [...credentials].map(([provider, apiKey]) => ({ provider, apiKey, updatedAt: 1 })),
    getProviderCredential: (provider) => {
      const apiKey = credentials.get(provider);
      return apiKey === undefined ? undefined : { provider, apiKey, updatedAt: 1 };
    },
    saveProviderCredential: (provider, apiKey) => {
      credentials.set(provider, apiKey);
    },
    deleteProviderCredential: (provider) => credentials.delete(provider),
    listProviderMemos: () => [...memos].map(([provider, memo]) => ({ provider, memo })),
    getProviderMemo: (provider) => {
      const memo = memos.get(provider);
      return memo === undefined ? undefined : { provider, memo };
    },
    saveProviderMemo: (provider, memo) => {
      memos.set(provider, memo);
    },
    deleteProviderMemo: (provider) => memos.delete(provider),
    readModelSettings: () => undefined,
    saveModelSettings: () => {},
  };
}

function serviceWith(
  runtimeOptions: Parameters<typeof fakeRuntime>[0] = {},
  options: { runtime?: ProviderKeyRuntime | null } = {},
) {
  const runtime = fakeRuntime(runtimeOptions);
  const db = fakeDb();
  const retained: string[] = [];
  const service = new ModelSettingsService({
    db,
    runtime: options.runtime === undefined ? runtime.service : options.runtime,
    retainSecret: (value) => retained.push(value),
    maskError: (text) => createSecretMasker([KEY]).mask(text),
    refreshModelState: async () => {},
    setModelSelection: () => {},
    ignoredEnvironmentVariables: [],
  });
  return { service, runtime, db, retained };
}

const createInput = (patch: Record<string, unknown> = {}) => ({
  id: "local-llm",
  baseUrl: "http://192.0.2.10:11434/v1",
  apiKey: KEY,
  model: { id: "qwen2.5-coder:7b", contextWindow: 32768 },
  ...patch,
});

/** 検証は httpError(400) を投げる。文言と状態だけを見る */
function rejects400(run: () => unknown, message: string): void {
  assert.throws(run, (error: unknown) => {
    const status = (error as { statusCode?: number }).statusCode;
    assert.equal(status, 400);
    assert.equal((error as Error).message, message);
    return true;
  });
}

test("id は先頭英小文字・英小文字と数字とハイフン・最大 64 文字だけを受け付ける", () => {
  for (const id of ["a", "local", "local-llm-2", "a".repeat(64)]) {
    assert.equal(parseCustomProviderInput(createInput({ id })).id, id);
  }
  for (const id of ["", "Local", "1local", "-local", "local-", "local_llm", "local/llm", "a b", "a".repeat(65)]) {
    rejects400(() => parseCustomProviderInput(createInput({ id })), CUSTOM_PROVIDER_ID_MESSAGE);
  }
  assert.equal(parseCustomProviderInput(createInput({ id: " local-llm " })).id, "local-llm", "前後の空白は落とす");
});

test("baseUrl は http / https だけを通し、userinfo・query・fragment を拒否して末尾の / を落とす", () => {
  assert.equal(normalizeCustomProviderBaseUrl("http://192.0.2.10:11434/v1/"), "http://192.0.2.10:11434/v1");
  assert.equal(normalizeCustomProviderBaseUrl("https://llm.example.test/v1//"), "https://llm.example.test/v1");
  assert.equal(normalizeCustomProviderBaseUrl(" http://llm.example.test "), "http://llm.example.test");
  for (const baseUrl of [
    "ftp://llm.example.test/v1",
    "llm.example.test/v1",
    "http://user:pass@llm.example.test/v1",
    "http://llm.example.test/v1?key=1",
    "http://llm.example.test/v1#frag",
    `http://llm.example.test/${"a".repeat(2048)}`,
    "",
  ]) {
    rejects400(() => normalizeCustomProviderBaseUrl(baseUrl), expectBaseUrlMessage());
  }
});

function expectBaseUrlMessage(): string {
  return "baseUrl は http / https の URL を指定してください（userinfo・query・fragment は不可）";
}

test("モデルは id 必須・空白なし、contextWindow 必須、maxTokens は既定 16384", () => {
  const definition = parseCustomProviderInput(createInput());
  assert.deepEqual(definition.model, { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 16384 });
  assert.equal(CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS, 16384);

  assert.equal(
    parseCustomProviderInput(createInput({ model: { id: "m", contextWindow: 1, maxTokens: 8 } })).model.maxTokens,
    8,
  );

  rejects400(
    () => parseCustomProviderInput(createInput({ model: { id: " ", contextWindow: 1 } })),
    "モデル ID は空白なしで 200 文字以内で指定してください",
  );
  rejects400(
    () => parseCustomProviderInput(createInput({ model: { id: "qwen 7b", contextWindow: 1 } })),
    "モデル ID は空白なしで 200 文字以内で指定してください",
  );
  rejects400(
    () => parseCustomProviderInput(createInput({ model: { id: "a".repeat(201), contextWindow: 1 } })),
    "モデル ID は空白なしで 200 文字以内で指定してください",
  );
  for (const contextWindow of [0, -1, 1.5, Number.NaN]) {
    rejects400(
      () => parseCustomProviderInput(createInput({ model: { id: "m", contextWindow } })),
      "contextWindow は正の整数で指定してください（実モデルの値より大きくしないでください）",
    );
  }
  rejects400(
    () => parseCustomProviderInput(createInput({ model: { id: "m", contextWindow: 1, maxTokens: 0 } })),
    "maxTokens は正の整数で指定してください",
  );
});

test("APIキーは 8..2048 文字。作成は必須で、更新の空欄は既存を維持する", () => {
  rejects400(() => parseCustomProviderInput(createInput({ apiKey: "short" })), expectApiKeyMessage());
  rejects400(() => parseCustomProviderInput(createInput({ apiKey: "a".repeat(2049) })), expectApiKeyMessage());

  const current: CustomProviderDefinition = parseCustomProviderInput(createInput());
  const kept = parseCustomProviderUpdate(
    { baseUrl: current.baseUrl, model: { id: "m2", contextWindow: 8192 }, apiKey: "" },
    current,
  );
  assert.equal(kept.apiKey, KEY, "空欄は既存を維持");
  assert.equal(kept.id, current.id, "id は変更できない");
  assert.equal(kept.model.id, "m2");

  const replaced = parseCustomProviderUpdate(
    { baseUrl: current.baseUrl, model: current.model, apiKey: "sk-new-dummy-key-0123456789" },
    current,
  );
  assert.equal(replaced.apiKey, "sk-new-dummy-key-0123456789");
  rejects400(
    () => parseCustomProviderUpdate({ baseUrl: current.baseUrl, model: current.model, apiKey: "short" }, current),
    expectApiKeyMessage(),
  );
});

function expectApiKeyMessage(): string {
  return "APIキーは 8〜2048 文字で指定してください";
}

test("名前は任意で 64 文字まで。空欄は id を既定にする", () => {
  assert.equal(parseCustomProviderInput(createInput()).name, "local-llm");
  assert.equal(parseCustomProviderInput(createInput({ name: " 自宅のLLM " })).name, "自宅のLLM");
  assert.equal(parseCustomProviderInput(createInput({ name: "" })).name, "local-llm");
  rejects400(
    () => parseCustomProviderInput(createInput({ name: "a".repeat(65) })),
    "名前は 64 文字以内で指定してください",
  );
});

test("Store は複数を持ち、並びを保ち、応答用の要約はキーを返さない", () => {
  const store = new CustomProviderStore();
  const first = parseCustomProviderInput(createInput());
  const second = parseCustomProviderInput(createInput({ id: "lab", baseUrl: "http://198.51.100.20:8000/v1" }));
  store.set(first);
  store.set(second);

  assert.deepEqual(store.ids(), ["local-llm", "lab"], "追加順を保つ");
  assert.equal(store.has("lab"), true);
  assert.equal(store.delete("lab"), true);
  assert.equal(store.has("lab"), false);

  store.set(second);
  const summaries = store.summaries();
  assert.equal(summaries.length, 2);
  assert.ok(!JSON.stringify(summaries).includes(KEY), "キーは要約に載せない");
  assert.deepEqual(summaries[1], {
    id: "lab",
    name: "lab",
    baseUrl: "http://198.51.100.20:8000/v1",
    api: "openai-completions",
    model: { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 16384 },
    hasKey: true,
  });
});

test("登録内容は openai-completions / text のみ / コスト 0 で、キーを含めない", () => {
  const config = customProviderRuntimeConfig(
    parseCustomProviderInput(createInput({ model: { id: "m", contextWindow: 8192, maxTokens: 2048 } })),
  );
  assert.deepEqual(config, {
    name: "local-llm",
    baseUrl: "http://192.0.2.10:11434/v1",
    api: "openai-completions",
    models: [
      {
        id: "m",
        name: "m",
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    ],
  });
  assert.ok(!JSON.stringify(config).includes(KEY), "キーは SDK の登録内容に含めない");
});

test("作成は retainSecret → 登録 → キー適用 → 再計算の順に進み、GET に custom と customProviders が載る", async () => {
  const { service, runtime, db, retained } = serviceWith();
  const outcome = await service.createCustomProvider(createInput());
  assert.equal(outcome.status, 200);
  assert.equal(outcome.status === 200 && outcome.response.state, "applied");
  assert.deepEqual(retained, [KEY], "キーは SDK より前にマスカーへ登録する");
  assert.deepEqual(runtime.calls, ["register:local-llm", `apply:local-llm:${KEY}`]);

  assert.deepEqual(db.credentials.size, 0, "provider_credentials に行を作らない");
  assert.deepEqual(db.memos.size, 0);

  const settings = service.settings();
  const provider = settings.providers.find((entry) => entry.provider === "local-llm");
  assert.equal(provider?.custom, true);
  assert.equal(provider?.credentialKind, "api_key");
  assert.equal(provider?.hiddenStoredOAuth, false);
  assert.equal(provider?.managed, false);
  assert.deepEqual(settings.customProviders, [
    {
      id: "local-llm",
      name: "local-llm",
      baseUrl: "http://192.0.2.10:11434/v1",
      api: "openai-completions",
      model: { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 16384 },
      hasKey: true,
    },
  ]);
  assert.ok(!JSON.stringify(settings).includes(KEY), "GET にキーを載せない");
  assert.ok(!runtime.calls.some((call) => call.startsWith("storedCredentialKind")), "auth.json を読まない");
});

test("作成は built-in / models.json の provider と id が衝突したら 400 で、SDK を触らない", async () => {
  const { service, runtime } = serviceWith();
  await assert.rejects(
    () => service.createCustomProvider(createInput({ id: "anthropic" })),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      assert.equal((error as Error).message, CUSTOM_PROVIDER_ID_CONFLICT_MESSAGE);
      return true;
    },
  );
  assert.deepEqual(runtime.calls, [], "衝突したら登録もキー適用もしない");
});

test("作成のキー適用に失敗したら登録と overlay を巻き戻し、503 で何も残さない", async () => {
  const { service, runtime } = serviceWith({ apply: () => failed });
  const outcome = await service.createCustomProvider(createInput());
  assert.deepEqual(outcome, { status: 503, error: CUSTOM_PROVIDER_APPLY_FAILED_MESSAGE });
  assert.deepEqual(runtime.calls, [
    "register:local-llm",
    `apply:local-llm:${KEY}`,
    `apply:local-llm:${KEY}`,
    "remove:local-llm",
    "unregister:local-llm",
  ]);
  assert.deepEqual(service.settings().customProviders, [], "store に定義を残さない");
});

test("SDK の登録検証に失敗したら 400 で、キーは適用しない", async () => {
  const { service, runtime } = serviceWith({
    register: () => {
      throw new Error("Provider local-llm: invalid baseUrl http://192.0.2.10:11434/v1");
    },
  });
  await assert.rejects(
    () => service.createCustomProvider(createInput()),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      assert.ok(!(error as Error).message.includes("192.0.2.10"), "SDK の生の文言を応答へ出さない");
      return true;
    },
  );
  assert.deepEqual(runtime.calls, ["register:local-llm"]);
  assert.deepEqual(service.settings().customProviders, []);
});

test("更新は同じ id を再登録し、キーの空欄ではキーを適用しない", async () => {
  const { service, runtime, retained } = serviceWith();
  await service.createCustomProvider(createInput());
  runtime.calls.length = 0;
  retained.length = 0;

  const outcome = await service.updateCustomProvider("local-llm", {
    name: "自宅のLLM",
    baseUrl: "http://192.0.2.11:11434/v1",
    apiKey: "",
    model: { id: "llama3:8b", contextWindow: 8192 },
  });
  assert.equal(outcome.status, 200);
  assert.deepEqual(runtime.calls, ["register:local-llm"], "キーを適用し直さない");
  assert.deepEqual(retained, []);
  const summary = service.settings().customProviders[0];
  assert.equal(summary.name, "自宅のLLM");
  assert.equal(summary.baseUrl, "http://192.0.2.11:11434/v1");
  assert.deepEqual(summary.model, { id: "llama3:8b", contextWindow: 8192, maxTokens: 16384 });
  assert.equal(summary.hasKey, true);
});

test("更新で新しいキーを入れたら適用し、失敗したら旧定義・旧キーへ戻して 503", async () => {
  let fail = false;
  const { service, runtime } = serviceWith({
    apply: (_provider, apiKey) => (fail && apiKey !== KEY ? failed : applied),
  });
  await service.createCustomProvider(createInput());
  runtime.calls.length = 0;

  const newKey = "sk-new-dummy-key-0123456789";
  fail = true;
  const outcome = await service.updateCustomProvider("local-llm", {
    baseUrl: "http://192.0.2.11:11434/v1",
    apiKey: newKey,
    model: { id: "llama3:8b", contextWindow: 8192 },
  });
  assert.deepEqual(outcome, { status: 503, error: CUSTOM_PROVIDER_APPLY_FAILED_MESSAGE });
  assert.deepEqual(runtime.calls, [
    "register:local-llm",
    `apply:local-llm:${newKey}`,
    `apply:local-llm:${newKey}`,
    "register:local-llm",
    `apply:local-llm:${KEY}`,
  ]);
  const summary = service.settings().customProviders[0];
  assert.equal(summary.baseUrl, "http://192.0.2.10:11434/v1", "旧定義へ戻す");
  assert.equal(summary.model.id, "qwen2.5-coder:7b");
  assert.deepEqual(runtime.registered.get("local-llm")?.models[0].id, "qwen2.5-coder:7b");
});

test("未登録の provider の更新・削除は 400、ランタイム無しは 503", async () => {
  const { service } = serviceWith();
  await assert.rejects(
    () =>
      service.updateCustomProvider("missing", {
        baseUrl: "http://192.0.2.10:11434/v1",
        model: { id: "m", contextWindow: 1 },
      }),
    (error: unknown) => (error as Error).message === CUSTOM_PROVIDER_NOT_FOUND_MESSAGE,
  );
  await assert.rejects(
    () => service.deleteCustomProvider("missing"),
    (error: unknown) => (error as Error).message === CUSTOM_PROVIDER_NOT_FOUND_MESSAGE,
  );

  const noRuntime = serviceWith({}, { runtime: null });
  assert.deepEqual(await noRuntime.service.createCustomProvider(createInput()), {
    status: 503,
    error: CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE,
  });
  assert.deepEqual(await noRuntime.service.deleteCustomProvider("local-llm"), {
    status: 503,
    error: CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE,
  });
});

test("削除は removeRuntimeApiKey → unregisterProvider の順で、同じ id を再登録しても古いキーが復活しない", async () => {
  const { service, runtime } = serviceWith();
  await service.createCustomProvider(createInput());
  runtime.calls.length = 0;

  const outcome = await service.deleteCustomProvider("local-llm");
  assert.equal(outcome.status, 200);
  assert.deepEqual(runtime.calls, ["remove:local-llm", "unregister:local-llm"]);
  assert.deepEqual(service.settings().customProviders, []);
  assert.equal(
    service.settings().providers.find((entry) => entry.provider === "local-llm"),
    undefined,
    "runtime の一覧からも消える",
  );
});

test("削除のキー削除に失敗したら 503 で何も消さない", async () => {
  const { service, runtime } = serviceWith({ remove: () => failed });
  await service.createCustomProvider(createInput());
  runtime.calls.length = 0;

  const outcome = await service.deleteCustomProvider("local-llm");
  assert.deepEqual(outcome, { status: 503, error: CUSTOM_PROVIDER_REMOVE_FAILED_MESSAGE });
  assert.deepEqual(runtime.calls, ["remove:local-llm", "remove:local-llm"]);
  assert.equal(service.settings().customProviders.length, 1, "定義を残す");
  assert.ok(runtime.registered.has("local-llm"));
});

test("カスタム provider では既存のキー / メモ / 再同期 API を 400 にする", async () => {
  const { service, db } = serviceWith();
  await service.createCustomProvider(createInput());

  for (const run of [
    () => service.putKey("local-llm", "sk-another-dummy-key-0123"),
    () => service.deleteKey("local-llm"),
    () => service.putMemo("local-llm", "memo"),
    () => service.resync("local-llm"),
  ]) {
    await assert.rejects(run, (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
  }
  assert.equal(db.credentials.size, 0);
  assert.equal(db.memos.size, 0);
});

test("別 provider の変更とは同じロックで直列化し、後から来た作成を待たせる", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { service } = serviceWith({
    apply: async () => {
      await gate;
      return applied;
    },
  });
  const first = service.createCustomProvider(createInput());
  const second = service.createCustomProvider(createInput({ id: "lab" }));
  await new Promise((resolve) => setImmediate(resolve));
  release?.();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test("ランタイム無しの GET は customProviders を空配列で返し、利用可能なモデルの保存は 503", async () => {
  const { service } = serviceWith({}, { runtime: null });
  const settings = service.settings();
  assert.equal(settings.runtimeAvailable, false);
  assert.deepEqual(settings.customProviders, []);
  assert.deepEqual(await service.putModelSelection({ allowedModels: null, defaultModel: null }), {
    status: 503,
    error: MODEL_SELECTION_RUNTIME_UNAVAILABLE_MESSAGE,
  });
});
