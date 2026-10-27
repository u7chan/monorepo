// カスタムプロバイダーの検証・保存行・作成 / 更新 / 削除 / 再同期の契約。SDK と DB は fake で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
  CUSTOM_PROVIDER_ID_CONFLICT_MESSAGE,
  CUSTOM_PROVIDER_ID_MESSAGE,
  CUSTOM_PROVIDER_INVALID_STORED_MESSAGE,
  CUSTOM_PROVIDER_NOT_FOUND_MESSAGE,
  CUSTOM_PROVIDER_NOT_STORED_MESSAGE,
  CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE,
  CUSTOM_PROVIDER_STORED_ROWS_MESSAGE,
  customProviderRowOf,
  customProviderRuntimeConfig,
  customProviderSummaryOfRow,
  normalizeCustomProviderBaseUrl,
  parseCustomProviderInput,
  parseCustomProviderUpdate,
  storedCustomProviderDefinition,
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
import type { CustomProviderRow, StoredAppSecret } from "../src/app-db";
import {
  APP_SECRET_DECRYPT_FAILED_MESSAGE,
  APP_SECRET_MASTER_KEY_MESSAGE,
  APP_SECRET_NOT_STORED_MESSAGE,
} from "../src/app-secrets";
import { testAppCipher } from "./app-secret-fixture";

const KEY = "sk-custom-dummy-key-0123456789";
const NEW_KEY = "sk-new-dummy-key-0123456789";

const applied: CredentialCommit = { outcome: "applied", synced: true };
const failed: CredentialCommit = { outcome: "not_applied" };

const CIPHER = testAppCipher();

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
    auth: (provider) => (registered.has(provider) ? { configured: true, source: "runtime" } : { configured: false }),
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

/** 保存行。暗号文は実体の AEAD (scope = custom_providers、AAD の所有者は provider) で作る */
function customRowOf(provider: string, apiKey: string, patch: Partial<CustomProviderRow> = {}): CustomProviderRow {
  const secret = CIPHER.encrypt("custom_providers", provider, apiKey);
  return {
    provider,
    name: provider,
    baseUrl: "http://192.0.2.10:11434/v1",
    modelId: "qwen2.5-coder:7b",
    contextWindow: 32768,
    maxTokens: 16384,
    ...secret,
    ...patch,
  };
}

function fakeDb(initial: { custom?: CustomProviderRow[]; credentials?: Record<string, string> } = {}) {
  const credentials = new Map<string, StoredAppSecret>();
  for (const [provider, apiKey] of Object.entries(initial.credentials ?? {})) {
    credentials.set(provider, CIPHER.encrypt("provider_credentials", provider, apiKey));
  }
  const memos = new Map<string, string>();
  const custom = new Map<string, CustomProviderRow>((initial.custom ?? []).map((row) => [row.provider, row]));
  const state = {
    failListCustom: false,
    failGetCustom: false,
    failSaveCustom: false,
    failDeleteCustom: false,
    error: new Error("sqlite failure"),
  };
  const db: ModelSettingsDb & { credentials: typeof credentials; memos: typeof memos; custom: typeof custom } = {
    credentials,
    memos,
    custom,
    listProviderCredentials: () =>
      [...credentials].map(([provider, secret]) => ({ provider, ...secret, updatedAt: 1 })),
    getProviderCredential: (provider) => {
      const secret = credentials.get(provider);
      return secret === undefined ? undefined : { provider, ...secret, updatedAt: 1 };
    },
    saveProviderCredential: (provider, secret) => {
      credentials.set(provider, secret);
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
    listCustomProviders: () => {
      if (state.failListCustom) throw state.error;
      return [...custom.values()];
    },
    getCustomProvider: (provider) => {
      if (state.failGetCustom) throw state.error;
      return custom.get(provider);
    },
    saveCustomProvider: (row) => {
      if (state.failSaveCustom) throw state.error;
      custom.set(row.provider, row);
    },
    deleteCustomProvider: (provider) => {
      if (state.failDeleteCustom) throw state.error;
      return custom.delete(provider);
    },
  };
  return { db, credentials, memos, custom, state };
}

function serviceWith(
  runtimeOptions: Parameters<typeof fakeRuntime>[0] = {},
  options: {
    runtime?: ProviderKeyRuntime | null;
    probeFetch?: typeof fetch;
    probeTimeoutMs?: number;
    cipher?: ReturnType<typeof testAppCipher> | null;
    db?: ReturnType<typeof fakeDb>;
    runtimeService?: ProviderKeyRuntime;
  } = {},
) {
  const runtime = fakeRuntime(runtimeOptions);
  const db = options.db ?? fakeDb();
  const retained: string[] = [];
  const service = new ModelSettingsService({
    db: db.db,
    runtime: options.runtimeService ?? (options.runtime === undefined ? runtime.service : options.runtime),
    retainSecret: (value) => retained.push(value),
    maskError: (text) => createSecretMasker([KEY, NEW_KEY]).mask(text),
    refreshModelState: async () => {},
    setModelSelection: () => {},
    ignoredEnvironmentVariables: [],
    appCipher: options.cipher === undefined ? testAppCipher() : options.cipher,
    ...(options.probeFetch === undefined ? {} : { probeFetch: options.probeFetch }),
    ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
  });
  return { service, runtime, retained, db };
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
    "http://llm.example.test/v1?x=1",
    "http://llm.example.test/v1#x",
    "",
  ]) {
    rejects400(() => normalizeCustomProviderBaseUrl(baseUrl), expectBaseUrlMessage());
  }
});

function expectBaseUrlMessage(): string {
  try {
    normalizeCustomProviderBaseUrl("ftp://llm.example.test/v1");
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("baseUrl の検証が通ってしまった");
}

test("モデルは id 必須・空白なし、contextWindow 必須、maxTokens は既定 16384", () => {
  assert.deepEqual(parseCustomProviderInput(createInput()).model, {
    id: "qwen2.5-coder:7b",
    contextWindow: 32768,
    maxTokens: CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
  });
  assert.deepEqual(
    parseCustomProviderInput(createInput({ model: { id: "m", contextWindow: 1, maxTokens: 1 } })).model,
    {
      id: "m",
      contextWindow: 1,
      maxTokens: 1,
    },
  );
  for (const model of [
    { id: "", contextWindow: 1 },
    { id: "a b", contextWindow: 1 },
    { id: "m", contextWindow: 0 },
    { id: "m", contextWindow: 1.5 },
    { id: "m", contextWindow: 1, maxTokens: 0 },
    { id: "m", contextWindow: 1, maxTokens: 1.5 },
  ]) {
    assert.throws(
      () => parseCustomProviderInput(createInput({ model })),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
      JSON.stringify(model),
    );
  }
});

test("APIキーは 8..2048 文字。作成は必須で、更新の空欄は既存を維持する", () => {
  for (const apiKey of ["", "short", "a".repeat(2049)]) {
    assert.throws(
      () => parseCustomProviderInput(createInput({ apiKey })),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
      `${apiKey.length} 文字は拒否する`,
    );
  }
  const current = parseCustomProviderInput(createInput());
  const update = (apiKey: string | undefined) =>
    parseCustomProviderUpdate(
      { baseUrl: "http://192.0.2.10:11434/v1", apiKey, model: { id: "m", contextWindow: 1 } },
      current,
    );
  assert.equal(update(undefined).apiKey, KEY);
  assert.equal(update("").apiKey, KEY);
  assert.equal(update("sk-another-dummy-key-0123").apiKey, "sk-another-dummy-key-0123");
  assert.throws(
    () => update("short"),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
  );
});

test("名前は任意で 64 文字まで。空欄は id を既定にする", () => {
  assert.equal(parseCustomProviderInput(createInput()).name, "local-llm");
  assert.equal(parseCustomProviderInput(createInput({ name: " 自宅のLLM " })).name, "自宅のLLM");
  assert.equal(parseCustomProviderInput(createInput({ name: "" })).name, "local-llm");
  rejects400(
    () => parseCustomProviderInput(createInput({ name: "a".repeat(65) })),
    "名前は 64 文字以内で指定してください",
  );
});

test("保存行から定義を組み立て、要約はキーを返さず hasKey を暗号文の有無で決める", () => {
  const row = customRowOf("local-llm", KEY);
  assert.deepEqual(storedCustomProviderDefinition(row, KEY), {
    id: "local-llm",
    name: "local-llm",
    baseUrl: "http://192.0.2.10:11434/v1",
    apiKey: KEY,
    model: { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 16384 },
  });

  const definition = parseCustomProviderInput(createInput());
  const secret = CIPHER.encrypt("custom_providers", definition.id, KEY);
  const saved = customProviderRowOf(definition, secret);
  assert.equal(saved.provider, "local-llm");
  assert.equal(saved.modelId, "qwen2.5-coder:7b");
  assert.equal(saved.contextWindow, 32768);
  assert.ok(!("apiKey" in saved), "保存行に平文キーの列を持たない");

  const summary = customProviderSummaryOfRow(saved);
  assert.deepEqual(summary, {
    id: "local-llm",
    name: "local-llm",
    baseUrl: "http://192.0.2.10:11434/v1",
    api: "openai-completions",
    model: { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 16384 },
    hasKey: true,
  });
  assert.ok(!JSON.stringify(summary).includes(KEY), "キーは要約に載せない");

  // 壊れた保存値は黙って既定へ落とさず、検証で止める (起動時は degraded に倒す)
  assert.throws(
    () => storedCustomProviderDefinition({ ...row, baseUrl: "ftp://llm.example.test" }, KEY),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
  );
  assert.throws(
    () => storedCustomProviderDefinition(row, "short"),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
  );
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

test("作成は retainSecret → DB 保存 → 登録 → キー適用 → 再計算の順に進み、GET は DB 行から組む", async () => {
  const { service, runtime, db, retained } = serviceWith();
  const outcome = await service.createCustomProvider(createInput());
  assert.equal(outcome.status, 200);
  assert.equal(outcome.status === 200 && outcome.response.state, "applied");
  assert.deepEqual(retained, [KEY], "キーは SDK より前にマスカーへ登録する");
  assert.deepEqual(runtime.calls, ["register:local-llm", `apply:local-llm:${KEY}`]);

  const row = db.custom.get("local-llm");
  assert.ok(row, "custom_providers に行を作る");
  assert.equal(CIPHER.decrypt("custom_providers", "local-llm", row), KEY, "キーは復号できる形で保存する");
  assert.ok(!Buffer.from(row.ciphertext).includes(Buffer.from(KEY)), "暗号文に平文キーを残さない");
  assert.equal(db.credentials.size, 0, "provider_credentials に行を作らない");
  assert.equal(db.memos.size, 0);

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

test("作成は built-in / 保存済みのカスタム / 削除待ちの id と衝突したら 400 で、SDK を触らない", async () => {
  const conflict = serviceWith();
  await assert.rejects(
    () => conflict.service.createCustomProvider(createInput({ id: "anthropic" })),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      assert.equal((error as Error).message, CUSTOM_PROVIDER_ID_CONFLICT_MESSAGE);
      return true;
    },
  );
  assert.deepEqual(conflict.runtime.calls, [], "衝突したら登録もキー適用もしない");

  const stored = serviceWith({}, { db: fakeDb({ custom: [customRowOf("local-llm", KEY)] }) });
  await assert.rejects(
    () => stored.service.createCustomProvider(createInput()),
    (error: unknown) => (error as Error).message === CUSTOM_PROVIDER_ID_CONFLICT_MESSAGE,
  );
  assert.deepEqual(stored.runtime.calls, []);

  const deleted = serviceWith();
  assert.equal((await deleted.service.createCustomProvider(createInput())).status, 200);
  deleted.runtime.calls.length = 0;
  // 後始末に失敗させて tombstone を残す
  deleted.runtime.service.removeApiKey = async () => {
    deleted.runtime.calls.push("remove:local-llm");
    return failed;
  };
  const removal = await deleted.service.deleteCustomProvider("local-llm");
  assert.equal(removal.status === 200 && removal.response.state, "applied_unsynced");
  deleted.runtime.calls.length = 0;
  await assert.rejects(
    () => deleted.service.createCustomProvider(createInput()),
    (error: unknown) => (error as Error).message === CUSTOM_PROVIDER_ID_CONFLICT_MESSAGE,
  );
  assert.deepEqual(deleted.runtime.calls, [], "tombstone 中は SDK も DB も触らない");
});

test("保存済みのキー / メモの行がある id では作成せず、行の削除を促す 400 にする", async () => {
  const { service, runtime } = serviceWith({}, { db: fakeDb({ credentials: { "local-llm": KEY } }) });
  await assert.rejects(
    () => service.createCustomProvider(createInput()),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      assert.equal((error as Error).message, CUSTOM_PROVIDER_STORED_ROWS_MESSAGE);
      return true;
    },
  );
  assert.deepEqual(runtime.calls, [], "孤立行があるときは SDK を触らない");

  const memo = serviceWith();
  memo.db.memos.set("local-llm", "以前のメモ");
  await assert.rejects(
    () => memo.service.createCustomProvider(createInput()),
    (error: unknown) => (error as Error).message === CUSTOM_PROVIDER_STORED_ROWS_MESSAGE,
  );
  assert.deepEqual(memo.service.settings().customProviders, [], "定義を残さない");
});

test("保存済みの行を読めないときは作成せず 503 にする", async () => {
  const { service, runtime, db } = serviceWith();
  db.db.getProviderCredential = () => {
    throw new Error("db unavailable");
  };
  await assert.rejects(
    () => service.createCustomProvider(createInput()),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 503,
  );
  assert.deepEqual(runtime.calls, []);
});

test("DB 書込に失敗したら 503 not_stored で、SDK も DB も変わらない", async () => {
  const { service, runtime, db } = serviceWith();
  db.state.failSaveCustom = true;
  assert.deepEqual(await service.createCustomProvider(createInput()), {
    status: 503,
    error: CUSTOM_PROVIDER_NOT_STORED_MESSAGE,
  });
  assert.deepEqual(runtime.calls, [], "DB が確定するまで SDK を触らない");
  assert.deepEqual(service.settings().customProviders, []);
});

test("master key 未設定では平文で保存せず 503 not_stored にする (削除は master key 無しでもできる)", async () => {
  const { service, runtime, db } = serviceWith(
    {},
    { cipher: null, db: fakeDb({ custom: [customRowOf("local-llm", KEY)] }) },
  );
  assert.deepEqual(await service.createCustomProvider(createInput({ id: "lab" })), {
    status: 503,
    error: APP_SECRET_NOT_STORED_MESSAGE,
  });
  assert.deepEqual(runtime.calls, []);
  assert.equal(db.custom.has("lab"), false, "行を作らない");

  // 復号できない行でも、定義の要約と削除はできる (平文フォールバックもしない)
  const settings = service.settings();
  assert.equal(settings.customProviders[0].hasKey, true);
  const outcome = await service.deleteCustomProvider("local-llm");
  assert.equal(outcome.status === 200 && outcome.response.state, "applied");
  assert.equal(db.custom.has("local-llm"), false);
});

test("キー適用に失敗しても 200 applied_unsynced で DB は戻さず、degraded を残す", async () => {
  const { service, runtime, db } = serviceWith({ apply: () => failed });
  const outcome = await service.createCustomProvider(createInput());
  assert.equal(outcome.status, 200);
  assert.equal(outcome.status === 200 && outcome.response.state, "applied_unsynced");
  assert.ok(outcome.status === 200);
  assert.equal(outcome.response.customProviders[0].degraded, "apply");
  assert.deepEqual(runtime.calls, ["register:local-llm", `apply:local-llm:${KEY}`, `apply:local-llm:${KEY}`]);
  assert.ok(db.custom.has("local-llm"), "DB 行は戻さない");

  // 再同期で収束する
  const resync = await service.resync("local-llm");
  assert.equal(resync.status === 200 && resync.response.state, "applied_unsynced");
  runtime.service.applyApiKey = async (provider, apiKey) => {
    runtime.calls.push(`apply:${provider}:${apiKey}`);
    return applied;
  };
  const recovered = await service.resync("local-llm");
  assert.equal(recovered.status === 200 && recovered.response.state, "applied");
  assert.equal(recovered.status === 200 && recovered.response.customProviders[0].degraded, undefined);
});

test("SDK の登録に失敗しても 200 applied_unsynced で、DB を正として残す", async () => {
  const { service, runtime } = serviceWith({
    register: () => {
      throw new Error("Provider local-llm: invalid name");
    },
  });
  const outcome = await service.createCustomProvider(createInput());
  assert.equal(outcome.status, 200);
  assert.ok(outcome.status === 200);
  assert.equal(outcome.response.state, "applied_unsynced");
  assert.equal(outcome.response.customProviders[0].degraded, "apply");
  assert.ok(!JSON.stringify(outcome.response).includes("invalid name"), "SDK の生の文言を応答へ出さない");
  assert.deepEqual(runtime.calls, ["register:local-llm"], "登録に失敗したらキーは適用しない");
  assert.equal(service.settings().customProviders.length, 1, "DB の行は残る");
});

test("更新はキーの空欄で既存の暗号文を維持し、登録だけやり直す", async () => {
  const { service, runtime, retained, db } = serviceWith();
  await service.createCustomProvider(createInput());
  const before = db.custom.get("local-llm");
  runtime.calls.length = 0;
  retained.length = 0;

  const outcome = await service.updateCustomProvider("local-llm", {
    name: "自宅のLLM",
    baseUrl: "http://192.0.2.11:11434/v1",
    apiKey: "",
    model: { id: "llama3:8b", contextWindow: 8192 },
  });
  assert.equal(outcome.status === 200 && outcome.response.state, "applied");
  assert.deepEqual(runtime.calls, ["register:local-llm"], "キーを適用し直さない");
  assert.deepEqual(retained, []);
  const after = db.custom.get("local-llm");
  assert.deepEqual(after?.ciphertext, before?.ciphertext, "既存の暗号文をそのまま残す");
  assert.deepEqual(after?.nonce, before?.nonce);

  const summary = service.settings().customProviders[0];
  assert.equal(summary.name, "自宅のLLM");
  assert.equal(summary.baseUrl, "http://192.0.2.11:11434/v1");
  assert.deepEqual(summary.model, { id: "llama3:8b", contextWindow: 8192, maxTokens: 16384 });
  assert.equal(summary.hasKey, true);
});

test("更新で新しいキーを入れたら適用し、失敗しても DB を正として 200 applied_unsynced にする", async () => {
  let failKey: string | undefined;
  const { service, runtime, db, retained } = serviceWith({
    apply: (_provider, apiKey) => (failKey !== undefined && apiKey === failKey ? failed : applied),
  });
  await service.createCustomProvider(createInput());
  runtime.calls.length = 0;
  retained.length = 0;

  failKey = NEW_KEY;
  const outcome = await service.updateCustomProvider("local-llm", {
    baseUrl: "http://192.0.2.11:11434/v1",
    apiKey: NEW_KEY,
    model: { id: "llama3:8b", contextWindow: 8192 },
  });
  assert.equal(outcome.status, 200);
  assert.ok(outcome.status === 200);
  assert.equal(outcome.response.state, "applied_unsynced");
  assert.equal(outcome.response.customProviders[0].degraded, "apply");
  assert.equal(retained.at(-1), NEW_KEY, "新しいキーを SDK より前にマスカーへ登録する");
  const row = db.custom.get("local-llm");
  assert.equal(CIPHER.decrypt("custom_providers", "local-llm", row!), NEW_KEY, "DB は新しいキーが正");
  assert.equal(outcome.response.customProviders[0].baseUrl, "http://192.0.2.11:11434/v1");

  // キー空欄のまま再同期すると、保存済みの新しいキーが復号されて適用される
  failKey = undefined;
  runtime.calls.length = 0;
  const recovered = await service.resync("local-llm");
  assert.equal(recovered.status === 200 && recovered.response.state, "applied");
  assert.deepEqual(runtime.calls, ["register:local-llm", `apply:local-llm:${NEW_KEY}`]);
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

test("削除は DB 削除 → removeRuntimeApiKey → unregisterProvider の順で、2 回目は 400 になる", async () => {
  const { service, runtime, db } = serviceWith();
  await service.createCustomProvider(createInput());
  runtime.calls.length = 0;

  const outcome = await service.deleteCustomProvider("local-llm");
  assert.equal(outcome.status === 200 && outcome.response.state, "applied");
  assert.deepEqual(runtime.calls, ["remove:local-llm", "unregister:local-llm"]);
  assert.equal(db.custom.has("local-llm"), false);
  assert.deepEqual(service.settings().customProviders, []);
  assert.equal(
    service.settings().providers.find((entry) => entry.provider === "local-llm"),
    undefined,
    "runtime の一覧からも消える",
  );
  await assert.rejects(
    () => service.deleteCustomProvider("local-llm"),
    (error: unknown) => (error as Error).message === CUSTOM_PROVIDER_NOT_FOUND_MESSAGE,
  );
});

test("削除の後始末に失敗したら 200 applied_unsynced + degraded remove の tombstone を残す", async () => {
  const { service, runtime, db } = serviceWith({ remove: () => failed });
  await service.createCustomProvider(createInput());
  runtime.calls.length = 0;

  const outcome = await service.deleteCustomProvider("local-llm");
  assert.equal(outcome.status, 200);
  assert.ok(outcome.status === 200);
  assert.equal(outcome.response.state, "applied_unsynced");
  assert.deepEqual(outcome.response.customProviders, [
    {
      id: "local-llm",
      name: "local-llm",
      baseUrl: "http://192.0.2.10:11434/v1",
      api: "openai-completions",
      model: { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 16384 },
      hasKey: false,
      degraded: "remove",
    },
  ]);
  assert.deepEqual(runtime.calls, ["remove:local-llm", "remove:local-llm"], "後始末は再試行してから諦める");
  assert.equal(db.custom.has("local-llm"), false, "DB 行は消えている");

  // tombstone 中は同じ id のキー / メモ / 作成を 400 で予約する
  for (const run of [
    () => service.putKey("local-llm", "sk-another-dummy-key-0123"),
    () => service.putMemo("local-llm", "memo"),
  ]) {
    await assert.rejects(run, (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
  }

  runtime.service.removeApiKey = async (provider) => {
    runtime.calls.push(`remove:${provider}`);
    return applied;
  };
  const recovered = await service.resync("local-llm");
  assert.ok(recovered.status === 200);
  assert.equal(recovered.response.state, "applied");
  assert.deepEqual(recovered.response.customProviders, []);

  // 解除後は同じ id を作り直せる
  assert.equal((await service.createCustomProvider(createInput())).status, 200);
});

test("カスタム provider では既存のキー / メモ API を 400 にし、再同期は受け付ける", async () => {
  const { service, db } = serviceWith();
  await service.createCustomProvider(createInput());

  for (const run of [
    () => service.putKey("local-llm", "sk-another-dummy-key-0123"),
    () => service.deleteKey("local-llm"),
    () => service.putMemo("local-llm", "memo"),
  ]) {
    await assert.rejects(run, (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
  }
  assert.equal(db.credentials.size, 0);
  assert.equal(db.memos.size, 0);
  const resync = await service.resync("local-llm");
  assert.equal(resync.status === 200 && resync.response.state, "applied");
});

test("起動時に built-in と id が衝突した provider は、更新・再同期・削除で runtime entry を変えない", async () => {
  // 起動時点で runtime に同じ id がある = models.json / built-in の provider。register しない
  const runtime = fakeRuntime({ providers: [{ provider: "local-llm", name: "組み込み" }] });
  const db = fakeDb({ custom: [customRowOf("local-llm", KEY)] });
  const { service } = serviceWith({}, { runtimeService: runtime.service, db });
  await service.applyStored();
  assert.deepEqual(runtime.calls, [], "衝突したら register もキー適用もしない");

  const settings = service.settings();
  assert.equal(settings.customProviders[0].degraded, "apply");
  assert.ok(settings.customProviders[0].degradedMessage, "画面が原因を推測しないよう固定文言を載せる");
  assert.equal(
    settings.providers.find((entry) => entry.provider === "local-llm")?.custom,
    undefined,
    "built-in の runtime entry を custom 扱いしない",
  );

  const update = await service.updateCustomProvider("local-llm", {
    baseUrl: "http://192.0.2.11:11434/v1",
    model: { id: "llama3:8b", contextWindow: 8192 },
  });
  assert.equal(update.status === 200 && update.response.state, "applied_unsynced");
  const resync = await service.resync("local-llm");
  assert.equal(resync.status === 200 && resync.response.state, "applied_unsynced");
  assert.deepEqual(runtime.calls, [], "built-in の登録もキーも触らない");

  const removed = await service.deleteCustomProvider("local-llm");
  assert.ok(removed.status === 200);
  assert.equal(removed.response.state, "applied", "登録していないので SDK 後始末は不要");
  assert.deepEqual(runtime.calls, []);
  assert.ok(runtime.registered.has("local-llm") === false);
  assert.deepEqual(
    runtime.service.list().map((entry) => entry.provider),
    ["local-llm"],
    "built-in の runtime entry は残る",
  );
});

test("起動時の復号に失敗した行は register せず degraded にし、平文へフォールバックしない", async () => {
  const runtime = fakeRuntime();
  // 別の scope で暗号化した行 = AAD が違うので復号できない
  const wrong = CIPHER.encrypt("provider_credentials", "local-llm", KEY);
  const db = fakeDb({
    custom: [{ ...customRowOf("local-llm", KEY), ciphertext: wrong.ciphertext, nonce: wrong.nonce }],
  });
  const { service } = serviceWith({}, { runtimeService: runtime.service, db });
  await service.applyStored();
  assert.deepEqual(runtime.calls, []);
  const summary = service.settings().customProviders[0];
  assert.equal(summary.degraded, "apply");
  assert.equal(summary.degradedMessage, APP_SECRET_DECRYPT_FAILED_MESSAGE);
  assert.equal(summary.hasKey, true, "暗号文があることは hasKey で伝える");
});

test("起動時の master key 未設定は固定文言つきの degraded にする", async () => {
  const runtime = fakeRuntime();
  const db = fakeDb({ custom: [customRowOf("local-llm", KEY)] });
  const { service } = serviceWith({}, { runtimeService: runtime.service, db, cipher: null });
  await service.applyStored();
  assert.deepEqual(runtime.calls, []);
  assert.equal(service.settings().customProviders[0].degradedMessage, APP_SECRET_MASTER_KEY_MESSAGE);
});

test("起動時に保存済みの定義を検証できない行は register しない", async () => {
  const runtime = fakeRuntime();
  const db = fakeDb({ custom: [customRowOf("local-llm", KEY, { baseUrl: "ftp://llm.example.test" })] });
  const { service } = serviceWith({}, { runtimeService: runtime.service, db });
  await service.applyStored();
  assert.deepEqual(runtime.calls, []);
  assert.equal(service.settings().customProviders[0].degradedMessage, CUSTOM_PROVIDER_INVALID_STORED_MESSAGE);
});

test("GET は復号しない (master key が無くても一覧を返す)", () => {
  const { service } = serviceWith(
    { apply: () => applied },
    { cipher: null, db: fakeDb({ custom: [customRowOf("local-llm", KEY)] }) },
  );
  const settings = service.settings();
  assert.deepEqual(
    settings.customProviders.map((entry) => entry.id),
    ["local-llm"],
  );
  assert.equal(settings.customProviders[0].degraded, undefined, "まだ評価していない行を未反映と断定しない");
});

test("カスタム行と同じ id の provider_credentials は適用せず、custom 側を正にする", async () => {
  const runtime = fakeRuntime();
  const db = fakeDb({
    custom: [customRowOf("local-llm", KEY)],
    credentials: { "local-llm": "sk-shadowed-dummy-key-01", anthropic: "sk-ant-dummy-key-a-0123456789" },
  });
  const { service } = serviceWith({}, { runtimeService: runtime.service, db });
  await service.applyStored();
  assert.deepEqual(
    runtime.calls.filter((call) => call.startsWith("apply:")),
    [`apply:local-llm:${KEY}`, "apply:anthropic:sk-ant-dummy-key-a-0123456789"],
    "同じ id の通常キー行は適用しない (行は消さない)",
  );
  assert.equal(db.credentials.has("local-llm"), true);
});

test("起動時はカスタム provider → モデルの選択 → provider_credentials → 再計算の順に適用する", async () => {
  const events: string[] = [];
  const runtime = fakeRuntime({
    apply: (provider) => {
      events.push(`apply:${provider}`);
      return applied;
    },
  });
  runtime.service.registerProvider = (provider, config) => {
    events.push(`register:${provider}`);
    runtime.registered.set(provider, config);
  };
  const db = fakeDb({
    custom: [customRowOf("local-llm", KEY)],
    credentials: { anthropic: "sk-ant-dummy-key-a-0123456789" },
  });
  db.db.readModelSettings = () => ({ allowedModels: null, defaultModel: "local-llm/qwen2.5-coder:7b" });
  const service = new ModelSettingsService({
    db: db.db,
    runtime: runtime.service,
    retainSecret: () => {},
    maskError: (text) => text,
    refreshModelState: async () => {
      events.push("refresh");
    },
    setModelSelection: () => {
      events.push("selection");
    },
    ignoredEnvironmentVariables: [],
    appCipher: testAppCipher(),
  });
  await service.applyStored();
  assert.deepEqual(events, ["register:local-llm", "apply:local-llm", "selection", "apply:anthropic", "refresh"]);
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

test("ランタイム無しの GET は DB 行を返し、degraded を付けず、変更は 503 にする", async () => {
  const { service } = serviceWith({}, { runtime: null, db: fakeDb({ custom: [customRowOf("local-llm", KEY)] }) });
  const settings = service.settings();
  assert.equal(settings.runtimeAvailable, false);
  assert.deepEqual(
    settings.customProviders.map((entry) => entry.id),
    ["local-llm"],
  );
  assert.equal(settings.customProviders[0].degraded, undefined);
  assert.deepEqual(await service.putModelSelection({ allowedModels: null, defaultModel: null }), {
    status: 503,
    error: MODEL_SELECTION_RUNTIME_UNAVAILABLE_MESSAGE,
  });
});

test("probe は保存済みのキーで復号でき、入力キーを上書きに使えばマスカーへ登録する", async () => {
  const seen: string[] = [];
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    return Response.json({ data: [{ id: "qwen2.5-coder:7b" }] });
  }) as typeof fetch;
  const { service, retained } = serviceWith({}, { probeFetch: fakeFetch });
  assert.equal((await service.createCustomProvider(createInput())).status, 200);
  retained.length = 0;

  const stored = await service.probeCustomProvider({
    provider: "local-llm",
    baseUrl: "http://192.0.2.10:11434/v1",
    apiKey: "",
  });
  assert.equal(stored.failure, null);
  assert.deepEqual(stored.models, [{ id: "qwen2.5-coder:7b" }]);
  assert.deepEqual(seen, [`Bearer ${KEY}`]);
  assert.deepEqual(retained, [KEY], "復号したキーは SDK より前にマスカーへ入れ直す");

  const typedKey = "sk-typed-key-0123456789";
  await service.probeCustomProvider({
    provider: "local-llm",
    baseUrl: "http://192.0.2.10:11434/v1",
    apiKey: typedKey,
  });
  assert.deepEqual(seen[1], `Bearer ${typedKey}`);
  assert.equal(retained.at(-1), typedKey, "入力されたキーもマスカーへ登録する");
});

test("probe は未知の provider・キー無し・短いキーを 400、復号できない保存キーを 503 にする", async () => {
  const { service } = serviceWith();
  for (const run of [
    () => service.probeCustomProvider({ provider: "ghost", baseUrl: "http://192.0.2.10:11434/v1", apiKey: KEY }),
    () => service.probeCustomProvider({ baseUrl: "http://192.0.2.10:11434/v1" }),
    () => service.probeCustomProvider({ baseUrl: "http://192.0.2.10:11434/v1", apiKey: "short" }),
  ]) {
    await assert.rejects(run, (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
  }

  const wrong = CIPHER.encrypt("provider_credentials", "local-llm", KEY);
  const broken = serviceWith(
    {},
    { cipher: null, db: fakeDb({ custom: [{ ...customRowOf("local-llm", KEY), ciphertext: wrong.ciphertext }] }) },
  );
  await assert.rejects(
    () =>
      broken.service.probeCustomProvider({
        provider: "local-llm",
        baseUrl: "http://192.0.2.10:11434/v1",
        apiKey: "",
      }),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 503,
  );
});

test("probe はミューテーションロックを取らず、キー・メモの変更を待たせない", async () => {
  let release: ((response: Response) => void) | undefined;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fakeFetch = (async () => gate) as typeof fetch;
  const { service, db } = serviceWith({}, { probeFetch: fakeFetch, probeTimeoutMs: 1_000 });

  const probing = service.probeCustomProvider({ baseUrl: "http://192.0.2.10:11434/v1", apiKey: KEY });
  const memo = await Promise.race([
    service.putMemo("anthropic", "probe-lock"),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
  ]);
  if (memo === "timeout") assert.fail("probe がロックを保持しているとメモ保存が待たされる");
  assert.equal(memo.status, 200);
  assert.equal(db.memos.get("anthropic"), "probe-lock");

  release?.(Response.json({ data: [{ id: "a" }] }));
  assert.equal((await probing).failure, null);
});
