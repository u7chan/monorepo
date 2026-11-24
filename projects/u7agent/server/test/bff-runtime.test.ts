// ランタイムなしの起動で何が止まるかを 1 か所で決めている境界 (server/src/bff-runtime.ts) の検証。
// 段はこの値だけを見るため、ここが変わると起動時の分岐が一斉に変わる。
import assert from "node:assert/strict";
import test from "node:test";
import { createBffRuntime } from "../src/bff-runtime";
import { AUTH_REQUIRED_MESSAGE } from "../src/model-state";
import type { ModelRef, RuntimeModelsResponse } from "../src/schema";
import { STUB_MODEL, asPiBff, createStubPi, type StubPiOptions } from "./stub-pi";

const KEY = "sk-ant-dummy-key-0123456789abcdef";

const CATALOG: RuntimeModelsResponse = {
  catalogCount: 2,
  availableCount: 1,
  versions: { piCodingAgent: "1.0.0" },
  providers: [
    {
      provider: "stub",
      auth: { configured: true, source: "environment", environmentVariables: [] },
      models: [
        { id: "stub-model", name: "Stub Model", available: true },
        { id: "stub-plain", name: "Stub Plain", available: false },
      ],
    },
  ],
};

const SETTERS = [
  "setModelSelection",
  "setContentGeneration",
  "setWebSearch",
  "setSpeechFormatStore",
  "setGitIdentity",
  "setSessionEnv",
  "setServe",
  "setAskUser",
  "setNetworkAccess",
  "setInvestigate",
] as const;

test("ランタイムなしでは、止まる機能を null / 空 / 素通しにし、設定の差し込みは何もしない", async () => {
  const runtime = createBffRuntime(null);
  assert.equal(runtime.pi, null);
  assert.equal(runtime.available, false);
  assert.equal(runtime.masker, undefined);
  assert.equal(runtime.maskError(`key=${KEY}`), `key=${KEY}`);
  assert.equal(runtime.generateImage, undefined);
  assert.equal(runtime.generateSpeech, undefined);
  assert.equal(runtime.generateBgm, undefined);
  assert.deepEqual(runtime.toolCatalog(), []);
  assert.equal(runtime.knownToolNames(), undefined);
  assert.deepEqual(runtime.modelOptions(), []);
  assert.deepEqual(runtime.secretValues(), []);
  assert.equal(
    runtime.webSearchTest(() => assert.fail("runner を作らない")),
    null,
  );
  assert.equal(runtime.titleSummaryGenerate(), null);
  assert.equal(runtime.oauthLogin(), null);
  assert.equal(runtime.providerKeys(), null);
  assert.deepEqual(runtime.codexAuth.status(), { state: "missing", kind: null });
  assert.equal(await runtime.codexAuth.resolve(), undefined);
  assert.equal(runtime.backupModels(() => null)({ provider: "stub", id: "stub-model" }), "unknown");
  for (const name of SETTERS) {
    (runtime[name] as (value: unknown) => void)(undefined);
  }
  runtime.retainSecret(KEY);
  await runtime.refreshModelState();
});

test("ランタイムがあるときは、マスク・登録・実効一覧を pi へ委譲する", async () => {
  const stub = createStubPi({ availableModels: [STUB_MODEL], modelCatalog: CATALOG });
  const runtime = createBffRuntime(asPiBff(stub));
  assert.equal(runtime.pi, asPiBff(stub));
  assert.equal(runtime.available, true);
  assert.equal(runtime.masker, stub.secretMasker);
  runtime.retainSecret(KEY);
  assert.equal(runtime.maskError(`key=${KEY}`), "key=[REDACTED]");
  assert.deepEqual(runtime.secretValues(), [KEY]);
  assert.deepEqual(runtime.toolCatalog(), stub.toolCatalog());
  assert.deepEqual(
    runtime.knownToolNames(),
    stub.toolCatalog().map((tool) => tool.name),
  );
  assert.deepEqual(
    runtime.modelOptions().map((option) => option.id),
    ["stub-model"],
  );
  assert.equal(runtime.generateImage, stub.generateImage);
  assert.equal(runtime.generateSpeech, stub.generateSpeech);
  assert.equal(runtime.generateBgm, stub.generateBgm);
  assert.ok(runtime.oauthLogin());
  assert.ok(runtime.providerKeys());
  assert.ok(runtime.titleSummaryGenerate());
  assert.ok(
    runtime.webSearchTest(() => ({ readEnabled: () => true, readProvider: () => "exa", readApiKey: () => KEY })),
  );

  const controller = new AbortController();
  await runtime.refreshModelState({ signal: controller.signal });
  assert.equal(stub.modelStateRefreshSignals.at(-1), controller.signal);
  runtime.setModelSelection({ allowedModels: undefined, defaultModel: undefined });
  assert.deepEqual(stub.modelSelections, [{ allowedModels: undefined, defaultModel: undefined }]);
  const variablesFor = () => ({});
  runtime.setSessionEnv({ variablesFor });
  assert.deepEqual(stub.sessionEnvs.at(-1), { variablesFor });
});

test("復元するモデルの可否は、カタログ → 許可リスト → 実効一覧の順に判断する", () => {
  const model = { provider: "stub", id: "stub-model" };
  const resolveWith = (
    options: StubPiOptions,
    readAllowedModels: () => readonly (typeof model)[] | null = () => null,
  ) => createBffRuntime(asPiBff(createStubPi(options))).backupModels(readAllowedModels);

  assert.equal(createBffRuntime(null).backupModels(() => null)(model), "unknown");
  // 実行時エラーがある間は一覧を信じない
  assert.equal(resolveWith({ availabilityError: "no key", modelCatalog: CATALOG })(model), "unknown");
  assert.equal(resolveWith({})(model), "unknown");
  assert.equal(resolveWith({ modelCatalog: { ...CATALOG, catalogCount: 0 } })(model), "unknown");
  assert.equal(resolveWith({ modelCatalog: CATALOG })({ provider: "stub", id: "stub-hole" }), "not_in_catalog");
  assert.equal(
    resolveWith({ modelCatalog: CATALOG }, () => [{ provider: "stub", id: "stub-plain" }])(model),
    "not_allowed",
  );
  assert.equal(resolveWith({ modelCatalog: CATALOG }, () => [model])(model), "available");
  // 許可リストを読めないときは「明示的な除外」を判断せず、実効一覧だけで決める
  assert.equal(
    resolveWith({ modelCatalog: CATALOG }, () => {
      throw new Error("読めない");
    })(model),
    "available",
  );
  assert.equal(resolveWith({ modelCatalog: CATALOG, availableModels: [] })(model), "unknown");
});

// 起動後にキーを消す / 認証が失効すると availabilityError が立つ。生成時に 1 回だけ読むと、
// そのあとの復元で判断できないモデルを落とす (backup/plan.ts の「判断できないものを落とさない」)。
test("復元するモデルの可否は生成後も判定のたびに読み、判断できない間は保持する", () => {
  const model = { provider: "stub", id: "stub-model" };
  let allowed: readonly ModelRef[] | null = null;
  const stub = createStubPi({ modelCatalog: CATALOG });
  const backupModels = createBffRuntime(asPiBff(stub)).backupModels(() => allowed);
  assert.equal(backupModels(model), "available");

  // 実行時エラーが立ったあとは、カタログに載っているモデルも許可リストの外のモデルも判断しない
  stub.availabilityError = AUTH_REQUIRED_MESSAGE;
  assert.equal(backupModels(model), "unknown");
  assert.equal(backupModels({ provider: "stub", id: "stub-gone" }), "unknown");
  allowed = [{ provider: "stub", id: "stub-plain" }];
  assert.equal(backupModels(model), "unknown");
});
