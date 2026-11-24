// 設定 → モデルの応答 DTO の組み立て。DB の行と runtime の状態だけを入力にし、サービスを通さずに検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { appSecretAvailable } from "../src/app-secrets";
import type { CustomProviderRow, ProviderCredentialRow, ProviderMemoRow } from "../src/app-db";
import type { CustomProviderSummarySource } from "../src/custom-providers";
import {
  composeModelSettingsResponse,
  type ModelSettingsResponseInput,
  type ModelSettingsRuntimeProvider,
  type ModelSettingsRuntimeView,
} from "../src/model-settings-response";
import type { RuntimeAuthStatusLike } from "../src/model-state";
import type { CredentialKind, OAuthLoginState } from "../src/schema";

const ciphertext = { ciphertext: new Uint8Array([1]), nonce: new Uint8Array([2]), keyVersion: 1 };

/** runtime の provider 一覧と認証状態の fake。呼ばれた provider を記録して、読まない契約も固定する */
function fakeRuntime(
  entries: ModelSettingsRuntimeProvider[],
  options: {
    auth?: (provider: string) => RuntimeAuthStatusLike | undefined;
    credentialKind?: (provider: string) => CredentialKind | null;
    storedCredentialKind?: (provider: string) => CredentialKind | undefined;
  } = {},
) {
  const calls: string[] = [];
  const view: ModelSettingsRuntimeView = {
    list: () => entries,
    auth: (provider) => options.auth?.(provider),
    credentialKind: (provider) => {
      calls.push(`credentialKind:${provider}`);
      return options.credentialKind?.(provider) ?? null;
    },
    storedCredentialKind: (provider) => {
      calls.push(`storedCredentialKind:${provider}`);
      return options.storedCredentialKind?.(provider);
    },
  };
  return { view, calls };
}

const builtin = (
  provider: string,
  patch: Partial<ModelSettingsRuntimeProvider> = {},
): ModelSettingsRuntimeProvider => ({
  provider,
  name: provider,
  canSetApiKey: true,
  supportsOAuth: false,
  canSignInHere: false,
  oauthLoginLabel: null,
  ...patch,
});

const credentialRow = (provider: string, updatedAt: number | null = 1): ProviderCredentialRow => ({
  provider,
  updatedAt,
  ...ciphertext,
});

const customRow = (provider: string, patch: Partial<CustomProviderRow> = {}): CustomProviderRow => ({
  provider,
  name: provider,
  baseUrl: "http://192.0.2.10:11434/v1",
  modelId: "qwen2.5-coder:7b",
  contextWindow: 32768,
  maxTokens: 16384,
  ...ciphertext,
  ...patch,
});

const customSource = (id: string): CustomProviderSummarySource => ({
  id,
  name: id,
  baseUrl: "http://192.0.2.10:11434/v1",
  model: { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 16384 },
});

const memoRow = (provider: string, memo: string): ProviderMemoRow => ({ provider, memo });

function inputOf(patch: Partial<ModelSettingsResponseInput> = {}): ModelSettingsResponseInput {
  return {
    runtime: fakeRuntime([]).view,
    credentialRows: [],
    memos: [],
    selection: { allowedModels: null, defaultModel: null },
    customRows: [],
    customRegistered: new Set(),
    tombstones: new Map(),
    degraded: new Map(),
    degradedMessages: new Map(),
    secretStates: new Map(),
    oauthLogin: null,
    ignoredEnvironmentVariables: [],
    ...patch,
  };
}

test("カスタム行だけが customProviders[] の正になり、同じ id の通常キー行・メモ行は providers[] へ混ぜない", () => {
  const runtime = fakeRuntime([builtin("anthropic"), builtin("local-llm")]);
  const response = composeModelSettingsResponse(
    inputOf({
      runtime: runtime.view,
      credentialRows: [credentialRow("anthropic", 20), credentialRow("local-llm", 30)],
      memos: [memoRow("local-llm", "custom の id"), memoRow("anthropic", "会社のキー")],
      customRows: [customRow("local-llm")],
      customRegistered: new Set(["local-llm"]),
    }),
  );

  assert.deepEqual(
    response.providers.map((entry) => entry.provider),
    ["anthropic", "local-llm"],
  );
  const anthropic = response.providers.find((entry) => entry.provider === "anthropic");
  assert.equal(anthropic?.managed, true);
  assert.equal(anthropic?.keyUpdatedAt, 20);
  assert.equal(anthropic?.memo, "会社のキー");
  assert.equal(anthropic?.custom, undefined);
  // custom 行と同じ id の credential / memo 行は DTO へ混ぜない (managed / memo はカスタム側だけが持つ)
  const custom = response.providers.find((entry) => entry.provider === "local-llm");
  assert.equal(custom?.custom, true);
  assert.equal(custom?.managed, false);
  assert.equal(custom?.memo, null);
  assert.equal(custom?.keyUpdatedAt, null);
  assert.deepEqual(response.customProviders, [
    {
      id: "local-llm",
      name: "local-llm",
      baseUrl: "http://192.0.2.10:11434/v1",
      api: "openai-completions",
      model: { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 16384 },
      hasKey: true,
    },
  ]);
});

test("custom: true はこのプロセスで register した id だけに付け、行があっても未登録なら付けない", () => {
  const runtime = fakeRuntime([builtin("local-llm")]);
  const response = composeModelSettingsResponse(
    inputOf({ runtime: runtime.view, customRows: [customRow("local-llm")], customRegistered: new Set() }),
  );
  assert.equal(response.providers[0]?.provider, "local-llm");
  assert.equal(response.providers[0]?.custom, undefined);
  assert.equal(response.customProviders.length, 1);
});

test("削除待ちの tombstone は行の無い id だけを末尾に足し、degraded remove / hasKey false で出す", () => {
  const response = composeModelSettingsResponse(
    inputOf({
      customRows: [customRow("kept")],
      tombstones: new Map([
        ["kept", customSource("kept")],
        ["deleting", customSource("deleting")],
      ]),
      degraded: new Map<string, "apply" | "remove">([
        ["kept", "apply"],
        ["deleting", "remove"],
      ]),
    }),
  );

  assert.deepEqual(
    response.customProviders.map((entry) => [entry.id, entry.degraded, entry.hasKey]),
    [
      ["kept", "apply", true],
      ["deleting", "remove", false],
    ],
  );
  // tombstone は customProviders[] にだけ出し、通常一覧へ幽霊行を足さない
  assert.deepEqual(response.providers, []);
});

test("runtime が無いときは degraded を付けず、DB の内容だけを返す", () => {
  const response = composeModelSettingsResponse(
    inputOf({
      runtime: null,
      customRows: [customRow("local-llm")],
      degraded: new Map([["local-llm", "apply"]]),
      degradedMessages: new Map([["local-llm", "固定文言"]]),
    }),
  );

  assert.equal(response.runtimeAvailable, false);
  assert.equal(response.customProviders[0]?.degraded, undefined);
  assert.equal(response.customProviders[0]?.degradedMessage, undefined);
  assert.deepEqual(response.providers, []);
});

test("orphan の credential 行は apply を自動付与し、メモだけの行は managed: false のまま出す", () => {
  const response = composeModelSettingsResponse(
    inputOf({ credentialRows: [credentialRow("ghost")], memos: [memoRow("memo-only", "思い出すためのメモ")] }),
  );

  assert.deepEqual(
    response.providers.map((entry) => [entry.provider, entry.orphan, entry.managed, entry.degraded, entry.memo]),
    [
      ["ghost", true, true, "apply", null],
      ["memo-only", true, false, undefined, "思い出すためのメモ"],
    ],
  );
});

test("assumedManaged は一覧を読めない apply のフォールバックだけに managed を補う", () => {
  const applied = composeModelSettingsResponse(
    inputOf({ assumedManaged: "anthropic", degraded: new Map([["anthropic", "apply"]]) }),
  );
  assert.deepEqual(
    applied.providers.map((entry) => [entry.provider, entry.managed, entry.orphan, entry.degraded]),
    [["anthropic", true, true, "apply"]],
  );

  const removed = composeModelSettingsResponse(inputOf({ degraded: new Map([["anthropic", "remove"]]) }));
  assert.deepEqual(
    removed.providers.map((entry) => [entry.provider, entry.managed, entry.degraded]),
    [["anthropic", false, "remove"]],
  );
});

test("keyAvailable / keyEvaluated は managed の行と復号結果の積で決める", () => {
  const response = composeModelSettingsResponse(
    inputOf({
      runtime: fakeRuntime([builtin("available"), builtin("unevaluated"), builtin("unmanaged")]).view,
      credentialRows: [credentialRow("available"), credentialRow("unevaluated")],
      secretStates: new Map([["available", appSecretAvailable()]]),
    }),
  );

  assert.deepEqual(
    response.providers.map((entry) => [
      entry.provider,
      entry.managed,
      entry.keyAvailable,
      entry.keyEvaluated,
      entry.keyErrorMessage === null,
    ]),
    [
      ["available", true, true, true, true],
      ["unevaluated", true, false, false, false],
      // 行が無い provider は保存なし = 評価済みとして扱う
      ["unmanaged", false, false, true, true],
    ],
  );
});

test("hiddenStoredOAuth は runtime の auth が runtime のときだけ読み、カスタム provider では読まない", () => {
  const runtime = fakeRuntime([builtin("anthropic"), builtin("local-llm")], {
    auth: () => ({ configured: true, source: "runtime" }),
    storedCredentialKind: () => "oauth",
  });
  const response = composeModelSettingsResponse(
    inputOf({ runtime: runtime.view, customRows: [customRow("local-llm")], customRegistered: new Set(["local-llm"]) }),
  );

  assert.equal(response.providers[0]?.hiddenStoredOAuth, true);
  assert.equal(response.providers[1]?.hiddenStoredOAuth, false);
  assert.deepEqual(runtime.calls, [
    "credentialKind:anthropic",
    "storedCredentialKind:anthropic",
    "credentialKind:local-llm",
  ]);
});

test("認証状態と OAuth の進行状態は DTO へそのまま写し、credentialKind は認証済みだけに聞く", () => {
  const login: OAuthLoginState = {
    status: "failed",
    authUrl: null,
    instructions: null,
    progress: null,
    input: null,
    select: null,
    userCode: null,
    error: "固定文言",
  };
  const runtime = fakeRuntime([builtin("anthropic", { canSignInHere: true, oauthLoginLabel: "サインイン" })], {
    auth: (provider) => (provider === "anthropic" ? { configured: true, source: "runtime" } : { configured: false }),
    credentialKind: () => "oauth",
  });
  const response = composeModelSettingsResponse(
    inputOf({
      runtime: runtime.view,
      oauthLogin: { stateOf: (provider) => (provider === "anthropic" ? login : null) },
    }),
  );

  assert.deepEqual(response.providers[0]?.auth, { configured: true, source: "runtime", environmentVariables: [] });
  assert.equal(response.providers[0]?.credentialKind, "oauth");
  assert.equal(response.providers[0]?.oauthLoginLabel, "サインイン");
  assert.equal(response.providers[0]?.canSignInHere, true);
  assert.deepEqual(response.providers[0]?.login, login);
  assert.deepEqual(runtime.calls, ["credentialKind:anthropic", "storedCredentialKind:anthropic"]);
});

test("利用可能なモデルは provider/model へ整形し、入力の配列をそのまま返さない", () => {
  const ignoredEnvironmentVariables = ["PI_MODEL"];
  const response = composeModelSettingsResponse(
    inputOf({
      selection: { allowedModels: [{ provider: "anthropic", id: "claude-x" }], defaultModel: "anthropic/claude-x" },
      ignoredEnvironmentVariables,
    }),
  );

  assert.deepEqual(response.allowedModels, ["anthropic/claude-x"]);
  assert.equal(response.defaultModel, "anthropic/claude-x");
  assert.deepEqual(response.ignoredEnvironmentVariables, ["PI_MODEL"]);
  assert.notEqual(response.ignoredEnvironmentVariables, ignoredEnvironmentVariables);
});
