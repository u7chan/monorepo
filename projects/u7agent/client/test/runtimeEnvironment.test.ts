// 設定 → ランタイムの表示変換と、health / モデルカタログ / 実行環境をまとめて取り直す手順を検証する。
// 状態コード 6 種・空一覧・部分失敗・refreshHealth の null 失敗扱い・古い応答の排除・ゲートを固定する。

import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeReloadGate,
  HEALTH_RELOAD_FAILED_MESSAGE,
  reloadRuntime,
  runtimeCommandRows,
  runtimeEnvironmentSummary,
  runtimeFetchStateOf,
} from "../src/lib/runtimeEnvironment";
import type { Health, RuntimeEnvironmentResponse, RuntimeEnvironmentState, RuntimeModelsResponse } from "../src/types";

const STATES: RuntimeEnvironmentState[] = [
  "connected",
  "not_configured",
  "unreachable",
  "unauthorized",
  "timeout",
  "probe_failed",
];

const HEALTH: Health = { ready: true, sandboxConfigured: true };
const MODELS: RuntimeModelsResponse = {
  whitelistConfigured: false,
  catalogCount: 0,
  whitelistCount: 0,
  availableCount: 0,
  versions: { piCodingAgent: "0.87.1" },
  providers: [],
};
const CONNECTED: RuntimeEnvironmentResponse = {
  state: "connected",
  environment: {
    os: "Debian GNU/Linux 13 (trixie)",
    arch: "x86_64",
    user: "node",
    isRoot: false,
    workspace: "/workspace",
  },
  commands: [{ name: "curl", version: "8.14.1" }],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("every state code has its own label, detail and tone", () => {
  const summaries = STATES.map((state) => [state, runtimeEnvironmentSummary(state)] as const);
  assert.equal(summaries.length, 6);
  for (const [state, summary] of summaries) {
    assert.ok(summary.label.length > 0, `${state} のラベル`);
    assert.ok(summary.detail.length > 0, `${state} の説明`);
  }
  assert.equal(runtimeEnvironmentSummary("connected").tone, "ok");
  assert.equal(runtimeEnvironmentSummary("probe_failed").tone, "danger");
  assert.equal(runtimeEnvironmentSummary("not_configured").tone, "muted");
  // 生のエラー文言や URL を表示文言に混ぜない
  for (const [, summary] of summaries) {
    assert.equal(/http:|token=|at \//.test(summary.detail), false);
  }
});

test("command rows keep the detected order and mark missing versions", () => {
  assert.deepEqual(runtimeCommandRows([]), []);
  assert.deepEqual(
    runtimeCommandRows([
      { name: "curl", version: "8.14.1" },
      { name: "npm", version: null },
    ]),
    [
      { key: "0-curl", name: "curl", version: "8.14.1" },
      { key: "1-npm", name: "npm", version: "バージョン不明" },
    ],
  );
  // 同名が来ても key が衝突しない
  assert.deepEqual(
    runtimeCommandRows([
      { name: "curl", version: null },
      { name: "curl", version: null },
    ]).map((row) => row.key),
    ["0-curl", "1-curl"],
  );
});

test("reloads all three sources and waits for them to settle", async () => {
  const models = deferred<RuntimeModelsResponse>();
  const environment = deferred<RuntimeEnvironmentResponse>();
  const healthCalls: number[] = [];
  const pending = reloadRuntime({
    includeHealth: true,
    refreshHealth: async () => {
      healthCalls.push(1);
      return HEALTH;
    },
    getModels: () => models.promise,
    getEnvironment: () => environment.promise,
  });
  models.resolve(MODELS);
  environment.resolve(CONNECTED);
  const results = await pending;
  assert.equal(healthCalls.length, 1);
  assert.deepEqual(results.health, { ok: true, value: HEALTH });
  assert.deepEqual(results.models, { ok: true, value: MODELS });
  assert.deepEqual(results.environment, { ok: true, value: CONNECTED });
});

test("treats a null health result as a failure and keeps the other two results", async () => {
  const results = await reloadRuntime({
    includeHealth: true,
    refreshHealth: async () => null,
    getModels: async () => MODELS,
    getEnvironment: async () => CONNECTED,
  });
  assert.deepEqual(results.health, { ok: false, message: HEALTH_RELOAD_FAILED_MESSAGE });
  assert.equal(results.models.ok, true);
  assert.equal(results.environment.ok, true);
});

test("keeps successful results when one source fails", async () => {
  const results = await reloadRuntime({
    includeHealth: true,
    refreshHealth: async () => HEALTH,
    getModels: async () => {
      throw new Error("モデル情報を取得できませんでした");
    },
    getEnvironment: async () => CONNECTED,
  });
  assert.deepEqual(results.health, { ok: true, value: HEALTH });
  assert.deepEqual(results.models, { ok: false, message: "モデル情報を取得できませんでした" });
  assert.deepEqual(results.environment, { ok: true, value: CONNECTED });
});

test("opening the page fetches only the catalog and the environment", async () => {
  let healthCalls = 0;
  const results = await reloadRuntime({
    includeHealth: false,
    refreshHealth: async () => {
      healthCalls += 1;
      return HEALTH;
    },
    getModels: async () => MODELS,
    getEnvironment: async () => CONNECTED,
  });
  assert.equal(healthCalls, 0, "親が持つ health を再取得しない");
  assert.equal(results.health, null);
  assert.equal(results.models.ok, true);
  assert.equal(results.environment.ok, true);
});

test("converts reload outcomes into fetch states without losing the previous value on success", () => {
  assert.deepEqual(runtimeFetchStateOf({ ok: true, value: CONNECTED }), { status: "ready", value: CONNECTED });
  assert.deepEqual(runtimeFetchStateOf<RuntimeEnvironmentResponse>({ ok: false, message: "失敗" }), {
    status: "error",
    message: "失敗",
  });
});

test("applies only the latest reload attempt", () => {
  const gate = createRuntimeReloadGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
  gate.invalidate();
  assert.equal(second(), false, "アンマウント後の応答は適用しない");
  const third = gate.begin();
  assert.equal(third(), true);
});
