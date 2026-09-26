// 設定 → モデルの表示変換。DOM を使わず、認証バッジ・並び・入力検証・保存後の文言だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  API_KEY_MAX_LENGTH,
  API_KEY_MIN_LENGTH,
  availableCountOf,
  deleteConfirmMessage,
  groupProviders,
  mutationNote,
  providerAuthBadge,
  resyncAvailable,
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
  whitelistConfigured: false,
  catalogCount: 2,
  whitelistCount: 2,
  availableCount: 1,
  versions: { piCodingAgent: "0.87.1" },
  providers: [
    {
      provider: "anthropic",
      auth: { configured: true, source: "environment", environmentVariables: [] },
      models: [
        { id: "a", name: "A", available: true, inWhitelist: true },
        { id: "b", name: "B", available: false, inWhitelist: true },
      ],
    },
  ],
};

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

test("設定済みを先頭に、未設定は後ろへ分ける (並びはサーバーの順)", () => {
  const settings: ModelsSettingsResponse = {
    runtimeAvailable: true,
    whitelistConfigured: false,
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
  };
  const groups = groupProviders(settings, CATALOG);
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
  const base: ModelsSettingsResponse = { runtimeAvailable: true, whitelistConfigured: false, providers: [] };
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
});

test("削除の確認は既存会話への影響を伝える", () => {
  const message = deleteConfirmMessage("Anthropic");
  assert.match(message, /Anthropic/);
  assert.match(message, /未ロードの会話/);
  assert.match(message, /auth\.json/);
});
