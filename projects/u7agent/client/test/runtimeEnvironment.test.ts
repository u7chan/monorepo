// 設定 → ランタイムの表示変換と、health / 実行環境をまとめて取り直す手順を検証する。
// 状態コード 6 種・空一覧・部分失敗・refreshHealth の null 失敗扱い・古い応答の排除・ゲートを固定する。
// モデルカタログは設定 → モデルへ移設したため、ここでは取得しない。

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
import type { Health, RuntimeEnvironmentResponse, RuntimeEnvironmentState } from "../src/types";

const STATES: RuntimeEnvironmentState[] = [
  "connected",
  "not_configured",
  "unreachable",
  "unauthorized",
  "timeout",
  "probe_failed",
];

const HEALTH: Health = { ready: true, sandboxConfigured: true };
/** 単発の取得 (再試行なし) を表す判定。親の health をそのまま適用してよいケース */
const alwaysCurrent = () => true;
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

test("reloads health and the environment and waits for them to settle", async () => {
  const environment = deferred<RuntimeEnvironmentResponse>();
  const healthCalls: number[] = [];
  const pending = reloadRuntime({
    includeHealth: true,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => {
      healthCalls.push(1);
      return HEALTH;
    },
    getEnvironment: () => environment.promise,
  });
  environment.resolve(CONNECTED);
  const results = await pending;
  assert.equal(healthCalls.length, 1);
  assert.deepEqual(results.health, { ok: true, value: HEALTH });
  assert.deepEqual(results.environment, { ok: true, value: CONNECTED });
});

test("treats a null health result as a failure and keeps the environment result", async () => {
  const results = await reloadRuntime({
    includeHealth: true,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => null,
    getEnvironment: async () => CONNECTED,
  });
  assert.deepEqual(results.health, { ok: false, message: HEALTH_RELOAD_FAILED_MESSAGE });
  assert.equal(results.environment.ok, true);
});

test("keeps a successful health result when the environment fails", async () => {
  const results = await reloadRuntime({
    includeHealth: true,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => HEALTH,
    getEnvironment: async () => {
      throw new Error("実行環境を取得できませんでした");
    },
  });
  assert.deepEqual(results.health, { ok: true, value: HEALTH });
  assert.deepEqual(results.environment, { ok: false, message: "実行環境を取得できませんでした" });
});

test("opening the page fetches only the environment", async () => {
  let healthCalls = 0;
  const results = await reloadRuntime({
    includeHealth: false,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => {
      healthCalls += 1;
      return HEALTH;
    },
    getEnvironment: async () => CONNECTED,
  });
  assert.equal(healthCalls, 0, "親が持つ health を再取得しない");
  assert.equal(results.health, null);
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

/**
 * 親 (useRuntimeCatalog.refreshHealth) と同じく、isCurrent が false なら親へ適用せず null を返す。
 * 画面の世代ゲートを親へ渡さないと、遅れて返った古い health が親の state を上書きする。
 */
function parentRefreshHealth(values: Array<Promise<Health>>, applied: string[]) {
  let calls = 0;
  return async (isCurrent?: () => boolean): Promise<Health | null> => {
    const value = await values[calls++]!;
    if (isCurrent && !isCurrent()) return null;
    applied.push(value.model ?? "");
    return value;
  };
}

function reloadWithHealth(
  isCurrent: () => boolean,
  refreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>,
) {
  return reloadRuntime({
    includeHealth: true,
    isCurrent,
    refreshHealth,
    getEnvironment: async () => CONNECTED,
  });
}

test("does not apply a stale health response to the parent after a newer reload", async () => {
  const gate = createRuntimeReloadGate();
  const applied: string[] = [];
  const stale = deferred<Health>();
  const fresh = deferred<Health>();
  const refreshHealth = parentRefreshHealth([stale.promise, fresh.promise], applied);

  const staleReload = reloadWithHealth(gate.begin(), refreshHealth);
  const freshReload = reloadWithHealth(gate.begin(), refreshHealth);
  // 新しい取得が先に返り、古い取得が後から返る順序を再現する
  fresh.resolve({ ...HEALTH, model: "new/model" });
  const freshResult = await freshReload;
  stale.resolve({ ...HEALTH, model: "stale/model" });
  const staleResult = await staleReload;

  assert.deepEqual(applied, ["new/model"], "古い応答は親の health へ適用しない");
  assert.deepEqual(freshResult.health, { ok: true, value: { ...HEALTH, model: "new/model" } });
  assert.deepEqual(staleResult.health, { ok: false, message: HEALTH_RELOAD_FAILED_MESSAGE });
});

test("does not apply health to the parent after the page unmounts", async () => {
  const gate = createRuntimeReloadGate();
  const applied: string[] = [];
  const health = deferred<Health>();
  const reload = reloadWithHealth(gate.begin(), parentRefreshHealth([health.promise], applied));
  gate.invalidate();
  health.resolve({ ...HEALTH, model: "late/model" });
  const result = await reload;

  assert.deepEqual(applied, [], "アンマウント後の応答は親の health へ適用しない");
  assert.deepEqual(result.health, { ok: false, message: HEALTH_RELOAD_FAILED_MESSAGE });
});
