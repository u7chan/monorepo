// モデル state の導出 (server/src/agent.ts) のオフライン検証。実 API も実 SDK ランタイムも使わない。
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AUTH_REQUIRED_MESSAGE,
  MODEL_WHITELIST_EMPTY_MESSAGE,
  deriveModelState,
  filterModelsByWhitelist,
  readModelState,
  unavailableModelState,
  type ModelSnapshot,
} from "../src/agent";
import { createSecretMasker, REDACTED } from "../src/redact";
import { STUB_MODEL, STUB_PLAIN_MODEL } from "./stub-pi";

const VERSIONS = { piCodingAgent: "0.87.1" };
const KEY = "sk-ant-dummy-key-0123456789abcdef";

function snapshot(overrides: Partial<ModelSnapshot> = {}): ModelSnapshot {
  return {
    available: [STUB_MODEL, STUB_PLAIN_MODEL],
    catalog: [STUB_MODEL, STUB_PLAIN_MODEL],
    providerIds: ["stub"],
    authStatuses: new Map([["stub", { configured: true, source: "environment" }]]),
    ...overrides,
  };
}

/** readModelState が読む SDK 面だけを持つ fake */
function fakeModelRuntime(options: {
  available?: () => Promise<ReturnType<typeof snapshot>["available"]>;
  providers?: () => { id: string }[];
  models?: () => ReturnType<typeof snapshot>["catalog"];
  authStatus?: (provider: string) => { configured: boolean; source?: string };
}) {
  return {
    getAvailable: options.available ?? (async () => [STUB_MODEL]),
    getProviders: options.providers ?? (() => [{ id: "stub" }]),
    getModels: options.models ?? (() => [STUB_MODEL]),
    getProviderAuthStatus: options.authStatus ?? (() => ({ configured: true, source: "environment" })),
  } as unknown as ModelRuntime;
}

test("保存された許可リストの積から選択肢を導出し、既定は保存値を使う", () => {
  const state = deriveModelState({
    snapshot: snapshot(),
    requested: { provider: "stub", id: "stub-plain" },
    whitelist: undefined,
    versions: VERSIONS,
  });
  assert.deepEqual(
    state.availableModels.map((model) => model.id),
    ["stub-model", "stub-plain"],
  );
  assert.equal(state.selectedModel?.id, "stub-plain");
  assert.equal(state.defaultModelError, undefined);
  assert.equal(state.availabilityError, undefined);
  assert.equal(state.modelOptions[0]?.supportsThinking, true);
});

test("保存された許可リストで絞り、既定が未設定なら先頭を使う", () => {
  const state = deriveModelState({
    snapshot: snapshot(),
    requested: undefined,
    whitelist: [{ provider: "stub", id: "stub-plain" }],
    versions: VERSIONS,
  });
  assert.deepEqual(
    state.availableModels.map((model) => model.id),
    ["stub-plain"],
  );
  assert.equal(state.selectedModel?.id, "stub-plain", "既定が未設定なら絞り込み後の先頭");
  assert.equal(state.defaultModelError, undefined);
});

test("許可リストの積が空なら許可リスト起因のエラーにする", () => {
  const state = deriveModelState({
    snapshot: snapshot(),
    requested: undefined,
    whitelist: [{ provider: "stub", id: "ghost" }],
    versions: VERSIONS,
  });
  assert.equal(state.modelWhitelistExcludesAll, true);
  assert.equal(state.availabilityError, MODEL_WHITELIST_EMPTY_MESSAGE);
  assert.deepEqual(state.availableModels, []);
});

test("認証済みプロバイダーが無ければ APIキー未設定の案内にする", () => {
  const unauthenticated = deriveModelState({
    snapshot: snapshot({
      available: [],
      authStatuses: new Map([["stub", { configured: false }]]),
    }),
    requested: undefined,
    whitelist: undefined,
    versions: VERSIONS,
  });
  assert.equal(unauthenticated.availabilityError, AUTH_REQUIRED_MESSAGE);

  const configured = deriveModelState({
    snapshot: snapshot({ available: [] }),
    requested: undefined,
    whitelist: undefined,
    versions: VERSIONS,
  });
  assert.match(configured.availabilityError ?? "", /利用可能なモデルがありません/);
});

test("保存された既定モデルが利用不能でも他候補へフォールバックしない", () => {
  const state = deriveModelState({
    snapshot: snapshot(),
    requested: { provider: "stub", id: "ghost" },
    whitelist: undefined,
    versions: VERSIONS,
  });
  assert.equal(state.selectedModel, undefined);
  assert.equal(state.defaultModelError, "保存された既定モデルは利用できません: stub/ghost");
});

test("getAvailable() の失敗は可用 0 + マスク済み理由を公開し、古い一覧を残さない", async () => {
  const masker = createSecretMasker([KEY]);
  const state = await readModelState({
    modelRuntime: fakeModelRuntime({
      available: async () => {
        throw new Error(`availability failed with ${KEY}`);
      },
      models: () => [STUB_MODEL],
    }),
    requested: undefined,
    whitelist: undefined,
    versions: VERSIONS,
    maskError: (error) => masker.mask(error instanceof Error ? error.message : String(error)),
  });
  assert.deepEqual(state.availableModels, []);
  assert.equal(state.selectedModel, undefined);
  assert.ok(state.availabilityError?.includes(REDACTED), "理由はマスクして公開する");
  assert.ok(!state.availabilityError?.includes(KEY));
  assert.equal(state.catalog, undefined, "可用の取得に失敗した回はカタログを出さない");
});

test("導出そのものが失敗しても可用 0 の安全な state にする", async () => {
  const state = await readModelState({
    modelRuntime: fakeModelRuntime({
      // SDK の契約外データ (null) を渡し、modelOptionOf を落とす
      available: async () => [null as unknown as typeof STUB_MODEL],
    }),
    requested: undefined,
    whitelist: undefined,
    versions: VERSIONS,
    maskError: (error) => String(error),
  });
  assert.deepEqual(state, unavailableModelState("モデル状態の再計算に失敗しました"));
});

test("カタログの導出が失敗しても選択肢は公開する", () => {
  const brokenCatalog: unknown[] = [null];
  const state = deriveModelState({
    snapshot: snapshot({ catalog: brokenCatalog as ModelSnapshot["catalog"] }),
    requested: undefined,
    whitelist: undefined,
    versions: VERSIONS,
  });
  assert.equal(state.catalog, undefined, "カタログは best-effort");
  assert.deepEqual(
    state.availableModels.map((model) => model.id),
    ["stub-model", "stub-plain"],
  );
});

test("カタログは provider ごとのモデルと available を返し、許可リストの情報を持たない", () => {
  const state = deriveModelState({
    snapshot: snapshot({
      catalog: [STUB_MODEL, STUB_PLAIN_MODEL],
      providerIds: ["stub"],
    }),
    requested: undefined,
    whitelist: [{ provider: "stub", id: "stub-model" }],
    versions: VERSIONS,
  });
  assert.equal(state.catalog?.catalogCount, 2);
  assert.equal(state.catalog?.availableCount, 2);
  assert.deepEqual(state.catalog?.versions, VERSIONS);
  assert.deepEqual(
    state.catalog?.providers[0]?.models.map((model) => [model.id, model.available]),
    [
      ["stub-model", true],
      ["stub-plain", true],
    ],
  );
  assert.ok(
    !JSON.stringify(state.catalog).includes("whitelist") && !JSON.stringify(state.catalog).includes("allowedModels"),
    "許可リストの情報は設定 API だけが持つ",
  );
});

test("filterModelsByWhitelist は入力順・重複を保ち、交差なしは空、未指定は全件", () => {
  const available = [STUB_MODEL, STUB_PLAIN_MODEL];
  assert.deepEqual(filterModelsByWhitelist(available, undefined), available);
  assert.deepEqual(
    filterModelsByWhitelist(available, [
      { provider: "stub", id: "stub-plain" },
      { provider: "stub", id: "stub-model" },
      { provider: "stub", id: "stub-plain" },
    ]).map((model) => model.id),
    ["stub-model", "stub-plain"],
    "available の順を保ち、重複した指定は 1 回だけ効く",
  );
  assert.deepEqual(filterModelsByWhitelist(available, [{ provider: "stub", id: "ghost" }]), []);
  assert.deepEqual(filterModelsByWhitelist(available, [{ provider: "openai", id: "stub-model" }]), []);
});
